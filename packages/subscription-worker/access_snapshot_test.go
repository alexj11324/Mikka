package worker

import (
	"context"
	"errors"
	"testing"
)

func TestAccessSnapshotIsReadOnlyAndBoundToOneSecret(t *testing.T) {
	name := "mikka-byos-00000000-0000-4000-8000-000000000001"
	store, err := NewAccessSnapshot(AccessSnapshot{Name: name, Value: "projection"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := store.Read(context.Background(), name)
	if err != nil || string(raw) != "projection" {
		t.Fatal("projection unavailable")
	}
	if _, err := store.Read(context.Background(), "mikka-byos-00000000-0000-4000-8000-000000000002"); !errors.Is(err, ErrMissing) {
		t.Fatal("other secret was readable")
	}
	if !errors.Is(store.Create(context.Background(), name, raw), ErrUnsupported) || !errors.Is(store.Delete(context.Background(), name), ErrUnsupported) {
		t.Fatal("snapshot allowed mutation")
	}
	if _, err := NewAccessSnapshot(AccessSnapshot{Name: "other", Value: "projection"}); err == nil {
		t.Fatal("invalid name accepted")
	}
}
