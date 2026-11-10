# Connection recovery

The client validates the current server's descriptor and orchestration protocol
before opening a replacement session. Descriptor requests bypass HTTP caches,
preserve the caller's cookie and redirect policy, and abort at their deadline.
No cached identity authorizes a replacement session.

Transient failures use jittered exponential backoff, capped at 15 seconds. An
explicit retry, application return or network change wakes that wait. Returning
online resets the retry ladder. Authentication and configuration failures remain
blocked rather than being retried continuously.

Browser focus, visibility and page-restoration events are coalesced within 500 ms.
After 30 seconds in the background, a restored page requests the existing fast
long-resume probe instead of the ordinary foreground probe. Browser freeze/resume
and persisted page restoration also select that path. Visible network changes,
including supported Wi-Fi/cellular change events, request a quick health check.
A healthy session is retained; a stalled setup can be cancelled and replaced,
while an in-progress snapshot synchronization is not restarted for duplicate
network notices.

The ordinary descriptor, connection setup and snapshot synchronization budgets
remain unchanged. Shortening retry backoff does not make an unavailable server
reachable or bypass authentication. Session recovery only reconnects transport
and resubscribes state; it does not replay agent turns, tool calls or mutations.
