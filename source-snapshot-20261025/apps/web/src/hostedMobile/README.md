# Immutable Android bootstrap

`control/mobile/index.html` loads `control/mobile/entry.tsx`, which imports only
this Hark bootstrap. The mobile Vite build emits `index.html` and its referenced
assets under `contrib/mobile-console/dist-ui`. The old MobileConsole and computer
prototype source remain available, but they are not APK startup entries.

This target reuses `components/hark` source fonts, original SVG glyphs, continuous
surfaces, light material roles and frozen sky. Service selection and native
confirmation are Vivic business mappings, not original Hark account validation.

The page accepts only a HTTPS origin, displays its normalized host, then requires
an explicit confirmation. In the immutable appassets origin it calls
`VivicAndroid.connectSpace(origin)`. The native app confirms and stores the chosen
non-secret origin, then opens that service's `/remote/` page. Errors arrive via
`vivic:space-connect-result` with `{ok:false,error}`.

This page does not put account credentials, device codes or model keys in URLs or
browser storage. It does not load an owner, model, scanner or server Space. A
normal browser gets an explicit HTTPS link after confirming the service; no
scripted redirect follows user input.
