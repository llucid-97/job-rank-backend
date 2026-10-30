-- Apply only after the Markdown-writing API deployment is fully Ready. Older
-- API instances still store PDF/DOCX bytes in this bucket during rollout.
update storage.buckets
set allowed_mime_types = array['text/markdown', 'text/plain']
where id = 'candidate-documents';
