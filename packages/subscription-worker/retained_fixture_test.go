package worker

import (
	"encoding/json"
	"errors"
	"os"
)

// Test-only synthetic vault values are saved before writes and semantic DELETE.
func retainFixtureValue(name string, value []byte) error {
	if os.Getenv("MIKKA_PRESERVE_BYOS_FIXTURES") != "1" {
		return nil
	}
	path := os.Getenv("MIKKA_BYOS_ARCHIVE_PATH")
	if path == "" {
		return errors.New("fixture archive path required")
	}
	payload, err := json.Marshal(struct {
		Name  string `json:"name"`
		Value []byte `json:"value"`
	}{name, value})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(payload, '\n'))
	return err
}
