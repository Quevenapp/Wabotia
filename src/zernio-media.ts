// Zernio OpenAPI MediaContentType: /v1/media/presign accepts only these MIME
// types. Other WhatsApp formats must use the inbox multipart send endpoint.
const presignTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/avi",
  "video/x-msvideo",
  "video/webm",
  "video/x-m4v",
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "application/x-subrip",
  "text/vtt",
]);

export function zernioPresignType(mime: string): string | null {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  return presignTypes.has(normalized) ? normalized : null;
}
