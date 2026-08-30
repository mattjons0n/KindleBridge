# KindleProbe

`KindleProbe` is an experimental, read-only iPhone feasibility test. It asks
ImageCaptureCore to discover locally attached camera/PTP-style devices and
compares their USB identifiers with the Kindle validated by this project:
`0x1949 / 0x9981`.

The probe never opens a device session, enumerates files, sends PTP commands,
or writes to the Kindle.

## Physical result

Tested on 2026-08-29 using Xcode 26.3 and an iPhone 16 running iOS 26.6.1.
ImageCaptureCore media authorization returned `Authorized`, but the connected
Kindle produced no add-device callback and `ICDeviceBrowser.devices` contained
zero devices after ten seconds.

This rules out ImageCaptureCore discovery for the tested iPhone/Kindle pairing.
It does not establish support for generic USB, MFi accessories, private APIs,
or custom bridge hardware.

## Run

Open `KindleProbe.xcodeproj`, select a personal signing team and a physical
iPhone, then run the app. Once installed, connect the Kindle to the iPhone and
keep both devices awake. The app requests media permission and shows the
authorization, discovered USB identifiers, and a copyable-style diagnostic log
on screen.
