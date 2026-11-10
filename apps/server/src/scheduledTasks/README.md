# Periodic task delivery

Interval and fixed-time tasks have at most one outstanding provider run per task
ID. Before sending, the scheduler checks persisted messages carrying that task
ID and their associated run status. Queued, preparing, starting, running and
waiting runs all block another delivery, including held queues and runs waiting
for approval or input.

A busy scheduled occurrence is skipped, not queued for catch-up. Its next due
time advances using the current schedule. The previous dispatch result,
`lastRunAt` and `runCount` are not changed by a skipped occurrence. Once the old
run reaches completed, failed, cancelled, interrupted or rolled-back status, the
next due occurrence may send normally.

The dispatch reservation is written transactionally, so concurrent dispatches
cannot bypass the outstanding-run check. State is read from the database rather
than an in-memory timeout: restarting the scheduler or changing the destination
does not allow the same task to send while its earlier message is unfinished.
Different task IDs do not block one another, even on the same thread.

Manual Run now also refuses an overlapping periodic run. This rule does not
change webhook event delivery, replay keys or coalescing semantics, and does not
cancel or remove any existing queued message or active run.
