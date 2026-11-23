-- Allow each signed-in user to permanently delete only their own generated images.
-- The browser gallery already exposes a DELETE action; Supabase Storage requires
-- an explicit DELETE policy in addition to the SELECT policy.
drop policy if exists "Users can delete own generated images" on storage.objects;

create policy "Users can delete own generated images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'user-generated-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
