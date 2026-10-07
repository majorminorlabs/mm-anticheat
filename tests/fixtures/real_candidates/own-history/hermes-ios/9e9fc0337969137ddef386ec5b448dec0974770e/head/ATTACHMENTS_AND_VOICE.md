# Attachments and dictation

The existing conversation composer now offers Files, Photo Library and Camera
when the connected bridge advertises `attachments`; Photo Library and Camera also require `imageUpload`. Voice input is native
speech-to-text and needs no Hermes audio capability. Keychain pairing is unchanged.

## Upload contract and limits

`POST /mobile/v1/attachments` requires application authentication, `chat.control`,
an authorized conversation, a simple filename, an allowed MIME type and base64
bytes. It returns a generated opaque `upload_id` and artifact metadata, never a
Studio destination path. A run submits up to four distinct IDs using
`POST /conversations/{id}/runs {text,attachment_ids}`. Files are attached through
Hermes' `file.attach`, images through `image.attach_bytes`, PDFs through `pdf.attach`.
Only the selected conversation receives them. A file-only message gets a short
ordinary inspection prompt.

Supported formats:

- PNG, JPEG, WebP and GIF, with matching magic bytes.
- PDF, with matching signature; Hermes renders a bounded preview of the first
  five pages. The prompt identifies that preview limit. Poppler (`pdftoppm`) must
  be available in Hermes' runtime PATH.
- UTF-8 text/Markdown/CSV/TSV, JSON (validated), and common code/config files:
  Python, Swift, JavaScript/TypeScript, C/C++, Rust, Go, Java/Kotlin, Ruby, shells,
  CSS/HTML/XML, YAML/TOML and SQL. Binary archives/executables are rejected.

Maximum 10 MiB per file (a Studio may configure a smaller limit), four files per
message, 40 MiB pending per conversation and 256 MiB total bridge staging. Empty
files, unknown fields/types, invalid base64, control characters, separators and
path traversal in filenames are rejected. Direct upload MIME and content are
checked independently of the picker.

Bridge staging is under its private `state/uploads/`: directory `0700`, generated
filenames, files `0600`. Ready uploads expire after 24 hours. Submitted staging
expires after seven days. Cleanup runs at startup, during staging and in the
five-second maintenance loop; it removes staging and its artifact metadata. Hermes'
canonical attachment copies/history follow Hermes' own retention policy; bridge
cleanup does not delete that history. There is no arbitrary filesystem browser.

Upload and send operations have independent idempotency keys and never automatically
retry after an uncertain outcome. A consumed upload cannot be submitted to another
run or conversation. Attachments stay visible/editable in the composer until a
confirmed send; removing one before send leaves any previously staged copy to expire.
Payload bytes are composer-only and excluded from encoded transcripts/checkpoints.

## Native photo and camera behavior

PhotosPicker supports up to four selections without granting broad library access.
Selected photos and new camera captures become real JPEG bytes with thumbnails and
remove controls before sending. Images are kept at practical resolution, bounded to
4096 pixels on the longest edge and JPEG quality 0.9; sources above 30 MiB or encoded
uploads above 10 MiB fail with a clear error. Files use security-scoped access only
while copying the selected bytes.

Camera capture uses the native UIImagePickerController preview/Use Photo flow.
Cancellation adds nothing. Unavailable cameras and denied permission produce a
Settings guidance error. `NSCameraUsageDescription` is supplied for both app builds.

## Voice input

The microphone control starts/stops `AVAudioEngine` plus `SFSpeechRecognizer`.
Partial recognized words populate the ordinary composer; Stop preserves that text
for editing, Cancel restores the pre-dictation draft, and Send uses the normal chat
path. No microphone audio is uploaded to the bridge. Leaving the conversation or
backgrounding the app cancels capture and releases the audio session.

The app requests microphone and speech-recognition permission, checks recognizer
availability, and reports denied or unavailable states. It sets
`requiresOnDeviceRecognition` when `supportsOnDeviceRecognition` is true. Other
languages/devices use Apple's network recognition and show that status while
listening. See [Apple's on-device recognition contract](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition).
This is short composer dictation, not a voice call or recorded-audio attachment.
The app supplies `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`.

## Validation

Bridge tests cover staging, actual send attachment routing, images, authentication,
size/MIME/name/path rejection, cleanup, bridge restart and duplicate/idempotent
selection. Swift transport tests check upload-to-send ID mapping and excluded
payload persistence. Installed-Hermes integration uses an isolated home and local
model. Physical camera/microphone/PhotosPicker validation requires an unlocked
phone; current results are recorded in BOT_MODE_VALIDATION.md.
