# Deployment decisions and invariants

This document locks the operating boundary for the first household release.

## Supported target

- Docker Engine 26 or newer with Docker Compose v2.24 or newer.
- Release images target `linux/amd64` and `linux/arm64` only.
- Multi-platform publishing uses Docker Buildx v0.13 or newer and the checked-in Bake definition.
- The Node base image is pinned by exact version and OCI-index digest in `Dockerfile`; supported per-platform digests are recorded in `base-image.lock`.
- The service is a standard OCI container. It has no host-vendor package, storage driver, share-mount helper, or USB device mapping.

## Storage layout

| Container path | Purpose | Mode | Recovery class |
| --- | --- | --- | --- |
| `/libraries` | Allowed parent for configured book roots | read-only | Original host data; never modified by Kindle Bridge |
| `/data` | Configuration, database, migration state, and delivery history | read-write | Durable; back up before upgrades |
| `/cache` | Covers and temporary/rebuildable artifacts | read-write | Disposable; rebuild from `/libraries` |

No other container filesystem path is writable. `TMPDIR` points directly to the rebuildable `/cache` mount so a fresh empty volume or bind mount is immediately usable. The host is responsible for mounting any local disk, NAS, SMB, or NFS storage before it is bound read-only into `/libraries`; storage credentials never enter Kindle Bridge.

## Network boundary

The no-login release is restricted to a trusted household LAN or VPN. Compose binds its plain-HTTP port to `127.0.0.1` by default. Remote access terminates HTTPS at a trusted reverse proxy, which forwards to the container and preserves the external Host. Firewall or VPN policy must reject WAN clients. A publicly reachable unauthenticated deployment is explicitly unsupported.

The operator chooses one stable private DNS name, for example `kindle-bridge.home.arpa`, and trusts its certificate on each client. Both allowed-origin and allowed-host settings must exactly match that external origin. Profiles organize catalogs; they do not authorize users.

## Browser and size budget

- Desktop Chromium with WebUSB is the supported client. The USB chooser always requires a user gesture; the container never receives a USB device mapping.
- WebUSB permission and the browser-local recovery journal are origin-specific. Changing the scheme, hostname, or port creates a different origin.
- A source book is limited to 200 MiB. Large-book acceptance testing budgets at least 1.5 GiB of free browser-process memory for one active conversion; concurrent conversions are not supported in the first household release.
- Conversion and PDOC preparation modify an in-memory derivative only. Source mounts remain read-only and are hash-checked by acceptance tests.

## Safety invariants

- No Calibre, backend converter, cloud converter, cloud book storage, analytics, or external cover lookup.
- WebUSB access is user initiated. On a clean connection the exact-byte self-test runs first and inventory follows automatically in the retained session. If exact cleanup is pending, only read-only recovery inventory runs first; acknowledgement must trigger a new self-test, inventory, and reconciliation before Send can resume.
- No overwrite or broad Kindle deletion. Cleanup uses only a trustworthy current-session handle.
- A confirmed green check requires strong evidence; ambiguity remains visible.
- Host paths, device serials, credentials, source bytes, and conversion output do not belong in routine logs.
