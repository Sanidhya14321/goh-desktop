//go:build bundled

package main

import _ "embed"

//go:embed engine-windows.bin
var enginePayload []byte

//go:embed engine-windows-notices.bin
var engineNotices []byte
