variable "IMAGE" {
  default = "kindle-bridge"
}

variable "VERSION" {
  default = "local"
}

variable "BUILD_DATE" {
  default = "unknown"
}

variable "VCS_REF" {
  default = "unknown"
}

variable "SOURCE_URL" {
  default = "local"
}

group "default" {
  targets = ["release"]
}

target "release" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${IMAGE}:${VERSION}"]
  args = {
    APP_VERSION = VERSION
    BUILD_DATE  = BUILD_DATE
    VCS_REF     = VCS_REF
    SOURCE_URL  = SOURCE_URL
  }
  attest = [
    "type=provenance,mode=max",
    "type=sbom",
  ]
}
