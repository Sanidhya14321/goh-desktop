// windows-icon writes a COFF resource object for the desktop executable.
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/tc-hib/winres"
)

func writeResource(source, destination, arch string) error {
	var target winres.Arch
	switch arch {
	case "amd64":
		target = winres.ArchAMD64
	case "arm64":
		target = winres.ArchARM64
	default:
		return fmt.Errorf("unsupported Windows architecture %q", arch)
	}
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	icon, err := winres.LoadICO(file)
	if err != nil {
		return err
	}
	var resources winres.ResourceSet
	// Wails looks up the window icon using resource ID 3.
	if err := resources.SetIcon(winres.ID(3), icon); err != nil {
		return err
	}
	out, err := os.Create(destination)
	if err != nil {
		return err
	}
	if err := resources.WriteObject(out, target); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func main() {
	if len(os.Args) != 4 {
		log.Fatal("usage: windows-icon <source.ico> <destination.syso> <arch>")
	}
	if err := writeResource(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		log.Fatal(err)
	}
}
