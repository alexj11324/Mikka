package worker

// Hosted model requests retain the full bounded prompt. The 100k-token
// conversation compaction estimate can allow ~400k UTF-8 bytes before system
// instructions and tool schemas, so 512 KiB is insufficient for that budget.
// These limits apply only to executeStream, not the native inference broker.
const (
	modelRequestMaxBytes          = 1 << 20
	modelConvertedRequestMaxBytes = 2 << 20
	modelRPCFrameMaxBytes         = 2 << 20
	// Frame budgets exclude LF. The old 512 KiB Scanner buffer included it.
	legacyRPCFrameMaxBytes = (512 << 10) - 1
)
