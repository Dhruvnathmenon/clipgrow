-- Blueprint-driven campaigns: store the full extracted document alongside the
-- few fields the earnings allocator and public tiles need as first-class columns.
ALTER TABLE campaigns ADD COLUMN model TEXT;
ALTER TABLE campaigns ADD COLUMN blueprint_json TEXT;
