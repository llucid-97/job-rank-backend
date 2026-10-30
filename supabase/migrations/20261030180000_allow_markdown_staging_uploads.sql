-- Markdown is accepted by the finalize endpoint as a plain-text source file.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown'
]
where id = 'candidate-document-staging';
