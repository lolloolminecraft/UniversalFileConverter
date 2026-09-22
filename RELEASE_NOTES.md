# Universal File Converter v3.2.0

First public API-driven release of Universal File Converter.

## What's included

- Chrome Manifest V3 extension with no Native Host or local conversion engines
- Four API providers: ConvertAPI, CloudConvert, FreeConvert and Convert3D
- User-managed API keys in Settings
- Automatic provider failover for supported `source → target` pairs
- Provider health tracking and cooldown handling for auth, quota, rate-limit, network and server failures
- Multi-file conversion queue
- Automatic result downloads
- Dynamic capability checks instead of a fake universal conversion matrix
- Format metadata registry containing 356 unique extensions
- Support groups for images, RAW, vector, video, audio, documents, PDF, spreadsheets, presentations, ebooks, archives, fonts, subtitles, 3D, CAD, data, markup, disk images, scientific/technical formats and other formats
- Privacy control to disable online conversion
- Customizable theme, colors, background and corner radius
- Direct links in Settings to the official API-key pages for every integrated provider

## Privacy

This release performs online conversion. Source files are uploaded directly to the selected third-party conversion provider. Automatic failover may send the same source file to another compatible provider if the previous provider fails.

The public build contains no bundled API keys.

## Installation

1. Download `UniversalFileConverter-3.2.0.zip` from this release.
2. Extract it.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the extracted `UniversalFileConverter` folder.
6. Open **Settings → API Providers**, add your own API key/token and click **Check**.
