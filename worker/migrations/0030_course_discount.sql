-- Course discounts + LITALK+ groundwork.
--
-- discount_satang: an optional promotional / sale price in satang (THB x100),
-- same unit as price_satang. NULL = no discount. When it is set AND lower than
-- price_satang the discount is "active": the course is on sale, the effective
-- price a student pays is discount_satang, and the original price_satang is
-- shown struck through. A value of 0 means "on sale for free". A value >=
-- price_satang is ignored (treated as no discount) so a stale discount never
-- raises the price. This is what the home page uses to surface promoted deals.
ALTER TABLE courses ADD COLUMN discount_satang INTEGER;

-- LITALK+ groundwork. LITALK+ is a future subscription; a course flagged here
-- is meant to be included in that plan. Stored now so authoring, catalogue and
-- home-page badges can be built ahead of the billing side. 0 = not included.
ALTER TABLE courses ADD COLUMN included_in_plus INTEGER NOT NULL DEFAULT 0;

-- Courses currently on sale, newest first — feeds the home-page promo strip.
CREATE INDEX idx_courses_discount ON courses(status, discount_satang);
