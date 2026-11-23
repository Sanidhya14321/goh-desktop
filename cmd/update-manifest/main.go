package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/Sanidhya14321/goh-desktop/internal/updates"
)

func main() {
	log.SetFlags(0)
	generate := flag.Bool("generate", false, "print a new public key and private seed")
	version := flag.String("version", "", "desktop version")
	engine := flag.String("engine", "", "upstream engine tag")
	channel := flag.String("channel", "stable", "update channel")
	base := flag.String("base", "", "version-specific download URL prefix")
	output := flag.String("output", "update.json", "signed output path")
	signChecksums := flag.String("sign-checksums", "", "sign a SHA256SUMS file")
	verifyChecksums := flag.String("verify-checksums", "", "verify a signed SHA256SUMS file with DESKTOP_UPDATE_PUBLIC_KEY")
	flag.Parse()
	if *verifyChecksums != "" {
		raw, err := os.ReadFile(*verifyChecksums)
		if err != nil {
			log.Fatal(err)
		}
		encoded, err := os.ReadFile(*verifyChecksums + ".sig")
		if err != nil {
			log.Fatal(err)
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
		if err != nil {
			log.Fatal("invalid checksum signature encoding")
		}
		key, err := base64.StdEncoding.DecodeString(os.Getenv("DESKTOP_UPDATE_PUBLIC_KEY"))
		if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, raw, signature) {
			log.Fatal("checksum signature verification failed")
		}
		return
	}
	if *generate {
		pub, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("PUBLIC=%s\nSEED=%s\n", base64.StdEncoding.EncodeToString(pub), base64.StdEncoding.EncodeToString(key.Seed()))
		return
	}
	seed, err := base64.StdEncoding.DecodeString(os.Getenv("DESKTOP_UPDATE_SEED"))
	if err != nil || len(seed) != ed25519.SeedSize {
		log.Fatal("DESKTOP_UPDATE_SEED must contain a base64 Ed25519 seed")
	}
	key := ed25519.NewKeyFromSeed(seed)
	public := key.Public().(ed25519.PublicKey)
	if pinned := os.Getenv("DESKTOP_UPDATE_PUBLIC_KEY"); pinned != "" && pinned != base64.StdEncoding.EncodeToString(public) {
		log.Fatal("signing seed does not match the pinned key")
	}
	if *signChecksums != "" {
		raw, err := os.ReadFile(*signChecksums)
		if err != nil {
			log.Fatal(err)
		}
		signature := ed25519.Sign(key, raw)
		if !ed25519.Verify(public, raw, signature) {
			log.Fatal("checksum signature self-check failed")
		}
		output := base64.StdEncoding.EncodeToString(signature) + "\n"
		if err := os.WriteFile(*signChecksums+".sig", []byte(output), 0644); err != nil {
			log.Fatal(err)
		}
		return
	}
	if _, err := updates.VersionOrdinal(*version); err != nil {
		log.Fatal(err)
	}
	m := updates.Manifest{Version: *version, Channel: *channel, EngineTag: *engine, Assets: map[string]updates.Asset{}}
	for _, file := range flag.Args() {
		target, file, ok := strings.Cut(file, "=")
		if !ok {
			log.Fatal("asset argument must be target=path")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			log.Fatal(err)
		}
		digest := sha256.Sum256(data)
		m.Assets[target] = updates.Asset{URL: strings.TrimRight(*base, "/") + "/" + filepath.Base(file), SHA256: hex.EncodeToString(digest[:]), Signature: ed25519.Sign(key, digest[:]), Size: int64(len(data))}
	}
	if len(m.Assets) == 0 {
		log.Fatal("supply at least one update asset")
	}
	raw, err := json.Marshal(m)
	if err != nil {
		log.Fatal(err)
	}
	data, err := json.MarshalIndent(updates.Envelope{Manifest: raw, Signature: ed25519.Sign(key, raw)}, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*output, append(data, '\n'), 0644); err != nil {
		log.Fatal(err)
	}
}
