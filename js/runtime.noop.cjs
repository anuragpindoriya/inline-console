// Edge runtime (middleware, edge routes) has no Node APIs to send with, so console calls there
// run untouched: the rewritten __icAt?.() call is a no-op when no runtime is installed.
