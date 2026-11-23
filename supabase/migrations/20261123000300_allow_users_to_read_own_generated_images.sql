-- Allow each signed-in user to list and read only their own generated images.
-- The Edge Function uploads with its service role; this policy enables the browser gallery.
drop policy if exists "Users can view own generated images" on storage.objects;

create policy "Users can view own generated images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'user-generated-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
