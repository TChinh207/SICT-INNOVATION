-- =====================================================================
--  RELIEFLINK AI - CƠ SỞ DỮ LIỆU ĐỂ ĐƯA WEB LÊN ONLINE  (PostgreSQL 13+)
--  Khớp với bản web hiện tại: index.html + style.css + script.js
--
--  Cách chạy (Supabase / Neon / Railway / VPS đều được):
--      psql "<chuỗi kết nối>" -f relieflink_online.sql
--  Hoặc dán toàn bộ file vào ô "SQL Editor" của Supabase rồi bấm Run.
--
--  - KHÔNG xóa dữ liệu: chạy lại nhiều lần vẫn an toàn (IF NOT EXISTS / ON CONFLICT).
--  - Chạy được cả trên CSDL mới lẫn CSDL đã tạo từ database.sql cũ (tự thêm cột còn thiếu).
--  - KHÔNG có tài khoản/dữ liệu mẫu có mật khẩu đoán được. Tạo admin ở mục 9.
--
--  ÁNH XẠ TỪ WEB (localStorage hiện tại)  ->  BẢNG
--    relieflink_users    -> users
--    relieflink_session  -> user_sessions
--    relieflink_sos      -> sos_requests (+ sos_ai_reasons, sos_attachments)
--    relieflink_pending  -> sos_requests (is_offline_origin = TRUE)
--    relieflink_read     -> notifications (is_read, read_at)
--    LEVELS / RULES      -> urgency_levels / ai_keyword_rules
--    ROLES               -> roles
--
--  CÁC TRƯỜNG FORM SOS  ->  CỘT
--    Họ và tên (bắt buộc)        -> sos_requests.full_name
--    Số điện thoại (bắt buộc)    -> sos_requests.phone
--    Mô tả tình trạng (bắt buộc) -> sos_requests.description  (kể cả phần giọng nói đã dịch thành chữ)
--    Gửi định vị (bắt buộc)      -> latitude, longitude, gps_accuracy_m, location_captured_at
--    Hình ảnh (tùy chọn, ≤ 3)    -> sos_attachments (kind = 'IMAGE')
--    Nhãn Đỏ/Vàng/Xanh do AI     -> urgency_level  (+ căn cứ ở sos_ai_reasons)
--
--  QUAN TRỌNG: trang web tĩnh KHÔNG thể kết nối trực tiếp vào PostgreSQL.
--  Cần một lớp API (Supabase, Node/Express, PHP, Python...) đứng giữa.
--  Gửi SOS: gọi hàm fn_submit_sos(...) ở mục 6 - một lệnh là lưu đủ mọi thứ.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- 1. BẢNG DANH MỤC
-- =====================================================================
CREATE TABLE IF NOT EXISTS roles (
    role_code             VARCHAR(20) PRIMARY KEY,
    label                 VARCHAR(60) NOT NULL,
    description           TEXT,
    requires_verification BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS urgency_levels (
    level_code    VARCHAR(10) PRIMARY KEY CHECK (level_code IN ('red','yellow','green')),
    label         VARCHAR(60) NOT NULL,
    short_label   VARCHAR(40) NOT NULL,
    description   TEXT        NOT NULL,
    color_hex     CHAR(7)     NOT NULL CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    priority_rank SMALLINT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS disaster_types (
    type_code VARCHAR(30) PRIMARY KEY,
    label     VARCHAR(80) NOT NULL,
    region    VARCHAR(10) NOT NULL DEFAULT 'ALL' CHECK (region IN ('NORTH','CENTRAL','SOUTH','ALL'))
);

CREATE TABLE IF NOT EXISTS need_types (
    need_code VARCHAR(30) PRIMARY KEY,
    label     VARCHAR(80) NOT NULL
);

CREATE TABLE IF NOT EXISTS vulnerable_groups (
    group_code VARCHAR(20) PRIMARY KEY,
    label      VARCHAR(60) NOT NULL
);

-- Bộ luật AI chấm nhãn = RULES trong script.js.
-- Cách chấm (giống assessSOS): chuẩn hóa văn bản (chữ thường, bỏ dấu; "đói"->hungry_, "gấp"->urgent_)
-- rồi dò từng luật bằng regex  \b(pattern)\b.
--   Có luật Đỏ khớp                     -> Đỏ
--   Có luật Xanh khớp, không có Vàng    -> Xanh
--   Có luật Vàng khớp                   -> Vàng
--   Không khớp luật nào                 -> Vàng (chờ cán bộ liên hệ xác minh)
CREATE TABLE IF NOT EXISTS ai_keyword_rules (
    rule_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_order    SMALLINT    NOT NULL UNIQUE,
    urgency_level VARCHAR(10) NOT NULL REFERENCES urgency_levels(level_code),
    pattern       TEXT        NOT NULL,
    reason        TEXT        NOT NULL,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE
);

-- =====================================================================
-- 2. TÀI KHOẢN (form Đăng nhập / Đăng ký)
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
    user_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name           VARCHAR(120) NOT NULL,
    phone               VARCHAR(10)  NOT NULL UNIQUE CHECK (phone ~ '^0[0-9]{9}$'),
    email               VARCHAR(160) UNIQUE CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    password_hash       TEXT         NOT NULL,   -- bcrypt/argon2 băm Ở PHÍA MÁY CHỦ, tuyệt đối không lưu mật khẩu thô
    role_code           VARCHAR(20)  NOT NULL REFERENCES roles(role_code),
    organization        VARCHAR(160),
    verification_status VARCHAR(10)  NOT NULL DEFAULT 'active' CHECK (verification_status IN ('pending','active','rejected')),
    verified_by         BIGINT REFERENCES users(user_id),
    verified_at         TIMESTAMPTZ,
    vneid_subject       VARCHAR(100) UNIQUE,     -- "sub" OpenID Connect khi liên thông VNeID
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_code, verification_status);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    remember_me BOOLEAN     NOT NULL DEFAULT FALSE,   -- ô "Ghi nhớ đăng nhập"
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN     NOT NULL DEFAULT FALSE,
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id) WHERE NOT revoked;

-- =====================================================================
-- 3. SỰ CỐ & TÍN HIỆU SOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS incidents (
    incident_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    center_lat        DOUBLE PRECISION NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
    center_lng        DOUBLE PRECISION NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
    radius_m          SMALLINT         NOT NULL DEFAULT 50 CHECK (radius_m BETWEEN 5 AND 500),
    urgency_level     VARCHAR(10)      NOT NULL REFERENCES urgency_levels(level_code),
    report_count      INT              NOT NULL DEFAULT 1 CHECK (report_count >= 1),
    status            VARCHAR(12)      NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISPATCHED','RESOLVED')),
    first_reported_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
    last_reported_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS sos_code_seq START 1;

CREATE TABLE IF NOT EXISTS sos_requests (
    sos_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sos_code          VARCHAR(30) NOT NULL UNIQUE
                      DEFAULT ('SOS_' || to_char(now(), 'YYYYMMDD') || '_' || lpad(nextval('sos_code_seq')::text, 4, '0')),
    client_ref        BIGINT,                                   -- rec.id do trình duyệt tạo (chống gửi trùng khi đồng bộ)
    user_id           BIGINT REFERENCES users(user_id) ON DELETE SET NULL,   -- NULL = gửi ẩn danh
    full_name         VARCHAR(120) NOT NULL CHECK (char_length(btrim(full_name)) >= 2),   -- ô "Họ và tên"
    phone             VARCHAR(10)  NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),                -- ô "Số điện thoại"
    description       TEXT         NOT NULL CHECK (char_length(description) BETWEEN 2 AND 500),   -- ô "Mô tả" (gồm cả chữ dịch từ giọng nói)
    urgency_level     VARCHAR(10)  NOT NULL REFERENCES urgency_levels(level_code),        -- nhãn AI gán
    is_manual_level   BOOLEAN      NOT NULL DEFAULT FALSE,      -- TRUE nếu cán bộ chỉnh lại nhãn
    disaster_type     VARCHAR(30)  REFERENCES disaster_types(type_code),
    victims_count     SMALLINT CHECK (victims_count >= 0),
    address_note      VARCHAR(255),
    latitude          DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90  AND 90),   -- tọa độ GPS thật từ nút "Gửi định vị"
    longitude         DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    gps_accuracy_m    REAL CHECK (gps_accuracy_m >= 0),         -- sai số GPS (mét) tại thời điểm lấy vị trí
    location_captured_at TIMESTAMPTZ,                           -- lúc thiết bị lấy được vị trí
    handling_status   VARCHAR(14)  NOT NULL DEFAULT 'NEW'
                      CHECK (handling_status IN ('NEW','ASSIGNED','IN_PROGRESS','RESOLVED','FALSE_REPORT')),
    incident_id       BIGINT REFERENCES incidents(incident_id) ON DELETE SET NULL,
    is_offline_origin BOOLEAN      NOT NULL DEFAULT FALSE,      -- gửi lúc mất mạng, đồng bộ sau
    client_created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),      -- lúc nạn nhân bấm gửi
    synced_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (phone, client_ref)
);

-- Nâng cấp CSDL cũ (tạo từ database.sql): thêm các cột mới nếu chưa có
ALTER TABLE sos_requests ADD COLUMN IF NOT EXISTS full_name VARCHAR(120) NOT NULL DEFAULT 'Chưa rõ';
ALTER TABLE sos_requests ALTER COLUMN full_name DROP DEFAULT;
ALTER TABLE sos_requests ADD COLUMN IF NOT EXISTS gps_accuracy_m REAL CHECK (gps_accuracy_m >= 0);
ALTER TABLE sos_requests ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sos_level_time ON sos_requests(urgency_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_created    ON sos_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_geo        ON sos_requests(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_sos_incident   ON sos_requests(incident_id);
CREATE INDEX IF NOT EXISTS idx_sos_user       ON sos_requests(user_id);

CREATE TABLE IF NOT EXISTS sos_ai_reasons (
    reason_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sos_id      BIGINT NOT NULL REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    reason_text TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasons_sos ON sos_ai_reasons(sos_id);

CREATE TABLE IF NOT EXISTS sos_needs (
    sos_id    BIGINT      NOT NULL REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    need_code VARCHAR(30) NOT NULL REFERENCES need_types(need_code),
    PRIMARY KEY (sos_id, need_code)
);

CREATE TABLE IF NOT EXISTS sos_vulnerable_groups (
    sos_id     BIGINT      NOT NULL REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    group_code VARCHAR(20) NOT NULL REFERENCES vulnerable_groups(group_code),
    PRIMARY KEY (sos_id, group_code)
);

-- Ảnh hiện trường (web gửi tối đa 3 ảnh JPEG đã nén ~800px).
-- file_url có thể là đường dẫn file đã upload (khuyên dùng: Supabase Storage / S3)
-- hoặc chuỗi "data:image/jpeg;base64,..." nếu muốn lưu thẳng vào CSDL.
CREATE TABLE IF NOT EXISTS sos_attachments (
    attachment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sos_id        BIGINT      NOT NULL REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    kind          VARCHAR(8)  NOT NULL CHECK (kind IN ('IMAGE','AUDIO')),
    file_url      TEXT        NOT NULL,
    mime_type     VARCHAR(60) NOT NULL,
    size_bytes    INT         NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attach_sos ON sos_attachments(sos_id);

-- =====================================================================
-- 4. THÔNG BÁO (chuông trên thanh điều hướng)
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
    notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT       NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    sos_id          BIGINT       REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    title           VARCHAR(160) NOT NULL,
    body            TEXT,
    is_read         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ,
    CHECK ((is_read AND read_at IS NOT NULL) OR (NOT is_read AND read_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_noti_user_unread ON notifications(user_id, created_at DESC) WHERE NOT is_read;

-- =====================================================================
-- 5. NGUỒN LỰC CỨU TRỢ & KHỚP NỐI
-- =====================================================================
CREATE TABLE IF NOT EXISTS resource_offers (
    offer_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('RESCUE_BOAT','FOOD','WATER','MEDICAL','VEHICLE','OTHER')),
    description   TEXT,
    quantity      INT         NOT NULL CHECK (quantity > 0),
    unit          VARCHAR(30) NOT NULL,
    latitude      DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude     DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    status        VARCHAR(12) NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','DISPATCHED','DEPLETED')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_matches (
    match_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id    BIGINT       NOT NULL REFERENCES resource_offers(offer_id) ON DELETE CASCADE,
    sos_id      BIGINT       NOT NULL REFERENCES sos_requests(sos_id) ON DELETE CASCADE,
    score       NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
    distance_km NUMERIC(8,2) NOT NULL CHECK (distance_km >= 0),
    route_note  TEXT,
    status      VARCHAR(10)  NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED','ACCEPTED','COMPLETED','REJECTED')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (offer_id, sos_id)
);

-- =====================================================================
-- 6. HÀM, TRIGGER, VIEW
-- =====================================================================

-- Khoảng cách đường chim bay (km)
CREATE OR REPLACE FUNCTION haversine_km(lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION, lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE AS $$
    SELECT 2 * 6371 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- Có SOS mới -> báo cho mọi cán bộ cứu hộ / Ban Chỉ đạo đã được xác minh
CREATE OR REPLACE FUNCTION fn_notify_new_sos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lv_short TEXT;
BEGIN
    SELECT short_label INTO lv_short FROM urgency_levels WHERE level_code = NEW.urgency_level;
    INSERT INTO notifications (user_id, sos_id, title, body)
    SELECT u.user_id, NEW.sos_id, 'Tín hiệu SOS · ' || lv_short,
           NEW.full_name || ' · ' || NEW.phone || ' - ' || NEW.description
    FROM users u
    WHERE u.role_code IN ('rescuer','admin') AND u.verification_status = 'active';
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_new_sos ON sos_requests;
CREATE TRIGGER trg_notify_new_sos AFTER INSERT ON sos_requests
FOR EACH ROW EXECUTE FUNCTION fn_notify_new_sos();

-- ---------------------------------------------------------------------
-- fn_submit_sos: LƯU MỘT TÍN HIỆU SOS (gọi khi bấm "Gửi tín hiệu khẩn cấp",
-- và khi đồng bộ các gói tin gửi lúc offline).
--  * Kiểm tra lại đủ 4 mục bắt buộc ở phía máy chủ (không tin riêng trình duyệt).
--  * Từ chối vị trí sai số > 1000 m hoặc không có độ chính xác (khớp MAX_ACCURACY_M trong script.js).
--  * Gửi trùng (cùng SĐT + cùng p_client_ref) -> trả lại bản đã có, không tạo bản mới.
--  * Trả về 1 dòng: out_sos_id, out_sos_code, out_duplicate.
--
--  Ví dụ:
--   SELECT * FROM fn_submit_sos(
--       p_client_ref := 1793170000123, p_full_name := 'Nguyễn Văn A', p_phone := '0912345678',
--       p_description := 'Nước dâng cao, nhà có người già', p_urgency := 'red',
--       p_lat := 16.463700, p_lng := 107.590900, p_accuracy := 12,
--       p_images := '["data:image/jpeg;base64,/9j/4AAQ..."]'::jsonb,
--       p_reasons := ARRAY['Nhắc đến ngập sâu / mắc kẹt trên mái nhà']);
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_submit_sos(
    p_client_ref         BIGINT,
    p_full_name          TEXT,
    p_phone              TEXT,
    p_description        TEXT,
    p_urgency            TEXT,
    p_lat                DOUBLE PRECISION,
    p_lng                DOUBLE PRECISION,
    p_accuracy           REAL,
    p_images             JSONB       DEFAULT '[]'::jsonb,
    p_reasons            TEXT[]      DEFAULT '{}',
    p_is_offline         BOOLEAN     DEFAULT FALSE,
    p_client_created_at  TIMESTAMPTZ DEFAULT now(),
    p_location_at        TIMESTAMPTZ DEFAULT NULL,
    p_user_id            BIGINT      DEFAULT NULL
) RETURNS TABLE (out_sos_id BIGINT, out_sos_code VARCHAR, out_duplicate BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
    v_phone TEXT := regexp_replace(regexp_replace(coalesce(p_phone, ''), '[\s.\-()]', '', 'g'), '^\+84', '0');
    v_name  TEXT := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
    v_desc  TEXT := btrim(coalesce(p_description, ''));
    v_id    BIGINT;
    v_code  VARCHAR;
    v_url   TEXT;
    v_r     TEXT;
BEGIN
    IF char_length(v_name) < 2 THEN RAISE EXCEPTION 'Thiếu họ và tên' USING ERRCODE = '22023'; END IF;
    IF v_phone !~ '^0[0-9]{9}$' THEN RAISE EXCEPTION 'Số điện thoại không hợp lệ' USING ERRCODE = '22023'; END IF;
    IF char_length(v_desc) < 2 THEN RAISE EXCEPTION 'Thiếu mô tả tình trạng' USING ERRCODE = '22023'; END IF;
    IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'Thiếu vị trí GPS' USING ERRCODE = '22023'; END IF;
    IF p_accuracy IS NULL OR p_accuracy > 1000 THEN
        RAISE EXCEPTION 'Vị trí GPS chưa đủ chính xác (sai số phải <= 1000 m)' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_images) <> 'array' OR jsonb_array_length(p_images) > 3 THEN
        RAISE EXCEPTION 'Tối đa 3 ảnh cho mỗi yêu cầu' USING ERRCODE = '22023';
    END IF;

    INSERT INTO sos_requests (client_ref, user_id, full_name, phone, description, urgency_level,
                              latitude, longitude, gps_accuracy_m, location_captured_at,
                              is_offline_origin, client_created_at, synced_at)
    VALUES (p_client_ref, p_user_id, v_name, v_phone, left(v_desc, 500), p_urgency,
            p_lat, p_lng, p_accuracy, coalesce(p_location_at, p_client_created_at),
            p_is_offline, p_client_created_at, CASE WHEN p_is_offline THEN now() END)
    ON CONFLICT (phone, client_ref) DO NOTHING
    RETURNING sos_requests.sos_id, sos_requests.sos_code INTO v_id, v_code;

    IF v_id IS NULL THEN   -- đã gửi trước đó
        SELECT s.sos_id, s.sos_code INTO v_id, v_code
        FROM sos_requests s WHERE s.phone = v_phone AND s.client_ref = p_client_ref;
        RETURN QUERY SELECT v_id, v_code, TRUE;
        RETURN;
    END IF;

    FOREACH v_r IN ARRAY coalesce(p_reasons, '{}') LOOP
        INSERT INTO sos_ai_reasons (sos_id, reason_text) VALUES (v_id, v_r);
    END LOOP;

    FOR v_url IN SELECT jsonb_array_elements_text(p_images) LOOP
        INSERT INTO sos_attachments (sos_id, kind, file_url, mime_type, size_bytes)
        VALUES (v_id, 'IMAGE', v_url,
                coalesce(substring(v_url FROM '^data:([a-z]+/[a-z0-9.+-]+);'), 'image/jpeg'),
                CASE WHEN v_url LIKE 'data:%' THEN (length(v_url) * 3 / 4) ELSE 0 END);
    END LOOP;

    RETURN QUERY SELECT v_id, v_code, FALSE;
END $$;

-- Ba ô thống kê Đỏ / Vàng / Xanh ở tab "Bản đồ điều phối"
DROP VIEW IF EXISTS v_sos_stats;
CREATE VIEW v_sos_stats AS
SELECT l.level_code, l.short_label, l.color_hex, COUNT(s.sos_id) AS total
FROM urgency_levels l
LEFT JOIN sos_requests s ON s.urgency_level = l.level_code AND s.handling_status <> 'FALSE_REPORT'
GROUP BY l.level_code, l.short_label, l.color_hex, l.priority_rank
ORDER BY l.priority_rank;

-- Danh sách "Tín hiệu gần đây"
DROP VIEW IF EXISTS v_recent_sos;
CREATE VIEW v_recent_sos AS
SELECT s.sos_id, s.sos_code, s.full_name, s.phone, s.description, s.urgency_level, l.short_label, l.color_hex,
       s.gps_accuracy_m,
       (SELECT count(*) FROM sos_attachments a WHERE a.sos_id = s.sos_id AND a.kind = 'IMAGE') AS image_count,
       s.handling_status, s.is_offline_origin, s.created_at
FROM sos_requests s JOIN urgency_levels l ON l.level_code = s.urgency_level
ORDER BY s.created_at DESC;

-- Chấm trên bản đồ + vòng tròn sai số GPS (chưa xử lý xong)
DROP VIEW IF EXISTS v_map_markers;
CREATE VIEW v_map_markers AS
SELECT s.sos_id, s.sos_code, s.full_name, s.phone, s.description, s.latitude, s.longitude, s.gps_accuracy_m,
       s.urgency_level, l.color_hex
FROM sos_requests s JOIN urgency_levels l ON l.level_code = s.urgency_level
WHERE s.handling_status NOT IN ('RESOLVED','FALSE_REPORT');

COMMENT ON TABLE users IS 'Tài khoản (người dân, cứu hộ, nhà hảo tâm, Ban Chỉ đạo PCTT)';
COMMENT ON TABLE sos_requests IS 'Tín hiệu SOS. user_id NULL = gửi ẩn danh. Vị trí là tọa độ GPS thật, kèm sai số (gps_accuracy_m)';
COMMENT ON TABLE ai_keyword_rules IS 'Bộ luật AI chấm nhãn Đỏ/Vàng/Xanh - đồng bộ với RULES trong script.js';
COMMENT ON TABLE incidents IS 'Hồ sơ sự cố duy nhất: gộp các SOS trùng trong bán kính 20-50m';

-- =====================================================================
-- 7. DỮ LIỆU DANH MỤC (an toàn khi chạy lại)
-- =====================================================================
INSERT INTO roles (role_code, label, description, requires_verification) VALUES
 ('citizen', 'Người dân',        'Người cần hỗ trợ hoặc báo tin thiên tai',                              FALSE),
 ('rescuer', 'Lực lượng cứu hộ', 'Công an, quân đội, đội xuồng/cano cứu hộ dân sự',                      TRUE),
 ('donor',   'Nhà hảo tâm',      'Cá nhân, tổ chức phi chính phủ, doanh nghiệp tài trợ',                 TRUE),
 ('admin',   'Ban Chỉ đạo PCTT', 'Ban Chỉ huy PCTT&TKCN các cấp - điều hành và phân bổ nguồn lực',      TRUE)
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO urgency_levels (level_code, label, short_label, description, color_hex, priority_rank) VALUES
 ('red',    'NHÃN ĐỎ - KHẨN CẤP TÍNH MẠNG',     'Đỏ - Khẩn cấp',
  'Nguy hiểm đến tính mạng: ngập sâu, mắc kẹt, sạt lở, có người bị thương hoặc nhóm dễ tổn thương. Được ưu tiên điều lực lượng cứu hộ ngay.', '#E53935', 1),
 ('yellow', 'NHÃN VÀNG - CẦN NHU YẾU PHẨM',     'Vàng - Cần vật tư',
  'Tạm an toàn về vị trí nhưng thiếu lương thực, nước sạch, thuốc men hoặc bị chia cắt. Cần tiếp tế sớm.', '#FDD835', 2),
 ('green',  'NHÃN XANH - AN TOÀN / ĐÃ ỨNG CỨU', 'Xanh - An toàn',
  'Đã có lực lượng tiếp cận hoặc đã nhận đủ hỗ trợ. Hệ thống chỉ ghi nhận để theo dõi.', '#4CAF50', 3)
ON CONFLICT (level_code) DO NOTHING;

INSERT INTO disaster_types (type_code, label, region) VALUES
 ('FLOOD_HIGH_RISK',   'Ngập lụt sâu',           'CENTRAL'),
 ('FLASH_FLOOD',       'Lũ quét / lũ ống',       'NORTH'),
 ('LANDSLIDE',         'Sạt lở đất',             'NORTH'),
 ('RIVERBANK_EROSION', 'Sạt lở bờ sông',         'SOUTH'),
 ('SALINE_INTRUSION',  'Hạn mặn / xâm nhập mặn', 'SOUTH'),
 ('STORM',             'Bão / gió lớn',          'ALL')
ON CONFLICT (type_code) DO NOTHING;

INSERT INTO need_types (need_code, label) VALUES
 ('RESCUE_BOAT',        'Xuồng / cano cứu hộ'),
 ('READY_TO_EAT_FOOD',  'Lương thực ăn liền'),
 ('CLEAN_WATER',        'Nước sạch'),
 ('MEDICINE',           'Thuốc men / y tế'),
 ('EVACUATION_VEHICLE', 'Phương tiện di tản'),
 ('SHELTER',            'Chỗ trú tạm')
ON CONFLICT (need_code) DO NOTHING;

INSERT INTO vulnerable_groups (group_code, label) VALUES
 ('ELDERLY','Người cao tuổi'), ('CHILD','Trẻ em'), ('INFANT','Trẻ sơ sinh'),
 ('PREGNANT','Phụ nữ mang thai'), ('DISABLED','Người khuyết tật'), ('SICK','Người bệnh nặng')
ON CONFLICT (group_code) DO NOTHING;

-- Bộ luật AI: khớp 1-1 với RULES trong script.js (9 luật)
INSERT INTO ai_keyword_rules (rule_order, urgency_level, pattern, reason) VALUES
 (1, 'red',    'ngap mai|trut noc|len tan tran|ngap sau|tren mai|mai nha|ngap nuoc',                         'Nhắc đến ngập sâu / mắc kẹt trên mái nhà'),
 (2, 'red',    'mac ket|sat lo|sat nui|vui lap|lu ong|lu quet|mat noc|chim ghe|duoi nuoc',                   'Có dấu hiệu mắc kẹt, sạt lở, lũ quét hoặc chìm phương tiện'),
 (3, 'red',    'bi thuong|thuong vong|chet|cap cuu|benh nang|chay mau|ngat|bat tinh',                        'Có người bị thương hoặc cần cấp cứu'),
 (4, 'red',    'mang thai|chuyen da|so sinh|em be|tre nho|tre em|nguoi gia|ba chau|cu gia|con nho',          'Có nhóm dễ bị tổn thương (trẻ em, người già, thai phụ)'),
 (5, 'red',    'cuu voi|cuu toi|nguy hiem|urgent_|khan cap',                                                 'Có từ ngữ kêu cứu khẩn cấp'),
 (6, 'yellow', 'het com|het meo|het luong|hungry_|can kiet|thieu luong|luong thuc',                          'Thiếu hoặc hết lương thực'),
 (7, 'yellow', 'het nuoc|khong co nuoc|nuoc sach|nuoc ngot|khat',                                            'Thiếu nước sạch'),
 (8, 'yellow', 'mat dien|co lap|chia cat|het thuoc|thieu thuoc|thuoc men',                                   'Mất điện / bị chia cắt / thiếu thuốc men'),
 (9, 'green',  'da duoc cuu|da co doi|da nhan|da duoc ho tro|an toan|da on',                                 'Cho biết đã được ứng cứu hoặc đã an toàn')
ON CONFLICT (rule_order) DO NOTHING;

-- =====================================================================
-- 8. TRUY VẤN THỬ (bỏ dấu -- để chạy)
-- =====================================================================
-- SELECT * FROM v_sos_stats;            -- 3 ô thống kê Đỏ/Vàng/Xanh
-- SELECT * FROM v_recent_sos LIMIT 10;  -- "Tín hiệu gần đây"
-- SELECT * FROM v_map_markers;          -- chấm trên bản đồ
-- SELECT count(*) FROM notifications WHERE user_id = 1 AND NOT is_read;   -- số đỏ trên chuông

-- =====================================================================
-- 9. TẠO TÀI KHOẢN QUẢN TRỊ ĐẦU TIÊN (đổi thông tin + mật khẩu rồi bỏ dấu -- để chạy)
-- =====================================================================
-- INSERT INTO users (full_name, phone, email, password_hash, role_code, organization, verification_status, verified_at)
-- VALUES ('Tên của bạn', '09xxxxxxxx', 'email@domain.vn', crypt('MAT_KHAU_MANH_CUA_BAN', gen_salt('bf')),
--         'admin', 'Ban Chỉ huy PCTT&TKCN', 'active', now());
