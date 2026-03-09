# Privacy Policy — MobX Spy

**Last updated:** March 9, 2026

## Overview

MobX Spy is a Chrome DevTools extension for profiling MobX state management events in locally-running web applications during development. It is designed with privacy as a core principle.

## Data Collection

MobX Spy does **not** collect, transmit, store, or share any user data. Specifically:

- No personal information is collected
- No browsing history is accessed or recorded
- No cookies or authentication tokens are read
- No analytics, telemetry, or tracking of any kind is implemented
- No data is sent to any server, API, or third party

## How Data is Handled

During a profiling session, MobX event data (actions, reactions, observable changes) is captured and held **entirely in memory** within the browser's DevTools panel. This data:

- Exists only for the duration of a profiling session
- Is cleared automatically when a new session starts or when DevTools closes
- Never leaves the user's browser
- Is never written to disk unless the user explicitly chooses to export it via the Save button, which saves a JSON file to the user's local filesystem

## Permissions

MobX Spy requires **zero browser permissions**. It does not access browsing history, cookies, network requests, or any other browser APIs beyond the DevTools extension API.

## Host Access

The extension's content script runs exclusively on localhost development URLs:

- `localhost`
- `127.0.0.1`
- `[::1]`
- `0.0.0.0`

It will not activate on any remote or production website.

## Remote Code

MobX Spy does not use any remote code. All code is bundled within the extension package.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in this document with an updated date.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/Khush08/mobx-spy-devtools/issues).
