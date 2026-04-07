-- ============================================================
-- Storage: eating-out-photos バケット
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('eating-out-photos', 'eating-out-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS
CREATE POLICY "eating_out_photos_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'eating-out-photos');

CREATE POLICY "eating_out_photos_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'eating-out-photos' AND auth.uid() IS NOT NULL);

CREATE POLICY "eating_out_photos_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'eating-out-photos' AND auth.uid() IS NOT NULL);

-- ============================================================
-- Realtime: テーブルのPublication有効化
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE meals;
ALTER PUBLICATION supabase_realtime ADD TABLE meal_reactions;
ALTER PUBLICATION supabase_realtime ADD TABLE shopping_items;
