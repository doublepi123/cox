export const OMO_SCHEDULE_BRIDGE_SOURCE = `
  if (typeof bridge.callTool === "function") {
    const maxAhead = 366 * 24 * 60 * 60 * 1000;
    const absoluteDateTime = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})$/i;
    let currentThread;
    const callScheduleTool = async (name, args, signal) => {
      const result = await bridge.callTool(name, args, signal);
      if (result.isError) throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\\n"));
      return result.structuredContent.structuredContent;
    };
    const readSchedule = async signal => {
      currentThread ??= (await callScheduleTool("cox_thread_configure", {}, signal)).threadId;
      const { tasks } = await callScheduleTool("list_scheduled_tasks", {}, signal);
      return { tasks, jobs: tasks.filter(task => task.boundThreadId === currentThread) };
    };
    const describeSchedule = task => {
      const prompt = task.prompt.length > 120 ? task.prompt.slice(0, 117) + "..." : task.prompt;
      return task.scheduledTaskId + " [enabled=" + task.enabled + "] " + JSON.stringify(task.schedule) +
        " nextRunAt=" + task.nextRunAt + " lastRunStatus=" + task.lastRunStatus + ": " + prompt;
    };
    pi.registerTool({
      name: "schedule_prompt",
      label: "Schedule Prompt",
      description: "Schedule prompts as Cox scheduled tasks delivered into THIS Cox thread. Jobs are visible in Cox's Scheduled tasks settings and survive OMO restarts. Create with prompt and exactly one of delaySeconds or at (ISO 8601 with Z/offset); optional everySeconds repeats (minimum 60). List this thread's jobs or cancel by id. Limits: prompt 16384 bytes, 50 enabled jobs per thread, 1000 enabled jobs per project, at most 366 days ahead or per interval.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")], {
          description: "create a job, list this session's jobs, or cancel one by id.",
        }),
        prompt: Type.Optional(Type.String({ description: "create: the prompt delivered to this session when the job fires." })),
        delaySeconds: Type.Optional(Type.Integer({ description: "create: fire this many seconds from now." })),
        at: Type.Optional(Type.String({ description: "create: absolute ISO 8601 date-time with UTC offset to fire at." })),
        everySeconds: Type.Optional(Type.Integer({ description: "create: repeat every N seconds (minimum 60)." })),
        id: Type.Optional(Type.String({ description: "cancel: the Cox scheduled task id returned by create or list." })),
      }, { additionalProperties: false }),
      exposure: "search",
      searchKeywords: ["reminder", "remind", "later", "schedule", "cron", "timer", "alarm", "follow up", "recurring"],
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        switch (params.action) {
          case "create": {
            const now = Date.now();
            const prompt = params.prompt?.trim() ?? "";
            if (!prompt) throw new Error("create needs a non-empty prompt.");
            if (Buffer.byteLength(prompt, "utf8") > 16384) throw new Error("prompt must be at most 16384 bytes.");
            const at = params.at?.trim() ?? "";
            if ((params.delaySeconds === undefined) === (at.length === 0))
              throw new Error("create needs exactly one of delaySeconds or at.");
            let due;
            if (params.delaySeconds !== undefined) {
              if (!Number.isSafeInteger(params.delaySeconds) || params.delaySeconds < 0)
                throw new Error("delaySeconds must be a non-negative integer.");
              due = now + params.delaySeconds * 1000;
            } else {
              if (!absoluteDateTime.test(at))
                throw new Error("at must be an ISO 8601 date-time with Z or a UTC offset: " + at);
              due = Date.parse(at);
              if (!Number.isFinite(due)) throw new Error("at is not a valid date-time: " + at);
              if (due < now - 60000)
                throw new Error("at (" + new Date(due).toISOString() + ") is in the past; now is " + new Date(now).toISOString() + ".");
            }
            if (due - now > maxAhead) throw new Error("a job can be scheduled at most 366 days ahead.");
            if (params.everySeconds !== undefined) {
              if (!Number.isSafeInteger(params.everySeconds) || params.everySeconds < 60)
                throw new Error("everySeconds must be an integer of at least 60.");
              if (params.everySeconds * 1000 > maxAhead)
                throw new Error("everySeconds must be at most " + maxAhead / 1000 + " (366 days).");
            }
            const schedule = params.everySeconds === undefined
              ? { type: "once", runAt: new Date(Math.max(due, now)).toISOString() }
              : { type: "interval", everyMs: params.everySeconds * 1000 };
            const { tasks, jobs } = await readSchedule(signal);
            if (tasks.filter(task => task.enabled).length >= 1000)
              throw new Error("the schedule already holds 1000 pending jobs; cancel some first.");
            if (jobs.filter(task => task.enabled).length >= 50)
              throw new Error("this session already has 50 pending jobs; cancel some first.");
            const task = await callScheduleTool("schedule_task", {
              prompt, schedule, title: "Scheduled prompt: " + prompt.split("\\n")[0].slice(0, 60),
              bindToCurrentThread: true,
            }, signal);
            let text = "Scheduled " + describeSchedule(task) + (params.everySeconds === undefined ? " (once)" : " (every " + params.everySeconds + "s)");
            if (params.everySeconds !== undefined && due - now !== params.everySeconds * 1000)
              text += "\\nCox starts the interval now and the first run comes after one interval.";
            return { content: [{ type: "text", text }], details: { action: "create", jobs: [task] } };
          }
          case "list": {
            const { jobs } = await readSchedule(signal);
            return { content: [{ type: "text", text: jobs.length ? jobs.map(describeSchedule).join("\\n") : "No scheduled jobs for this session." }],
              details: { action: "list", jobs } };
          }
          case "cancel": {
            const id = params.id?.trim() ?? "";
            if (!id) throw new Error("cancel needs the job id.");
            const { jobs } = await readSchedule(signal);
            const task = jobs.find(task => task.scheduledTaskId === id);
            if (!task) throw new Error("No scheduled job " + id + " in this session.");
            await callScheduleTool("delete_scheduled_task", { scheduledTaskId: id }, signal);
            return { content: [{ type: "text", text: "Cancelled " + id + "." }], details: { action: "cancel", jobs: [task] } };
          }
          default: throw new Error("Unknown schedule action: " + params.action);
        }
      },
    });
  }
`;
