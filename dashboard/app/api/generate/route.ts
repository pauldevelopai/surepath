import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import path from "path";

// Store pipeline state in memory (keyed by job id)
const jobs = new Map<string, { status: string; step: number; error?: string; result?: Record<string, unknown> }>();

export { jobs };

export const POST = withAuth(async (req: NextRequest) => {
  const { input, asking_price, phone_number } = await req.json();

  const jobId = `job_${Date.now()}`;
  jobs.set(jobId, { status: "running", step: 1 });

  // Run pipeline asynchronously
  (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pipelinePath = path.resolve(process.cwd(), "..", "pipeline.js");
      const mod = await import(/* webpackIgnore: true */ pipelinePath);
      const generateReport = mod.generateReport || mod.default?.generateReport;

      if (!generateReport) throw new Error("pipeline.js not found or generateReport not exported");

      // Patch console.log to track steps
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        const msg = args.join(" ");
        const stepMatch = msg.match(/STEP\s+(\d+)/);
        if (stepMatch) {
          const step = parseInt(stepMatch[1]);
          const job = jobs.get(jobId);
          if (job) job.step = step;
        }
        origLog(...args);
      };

      const result = await generateReport(input, asking_price, phone_number);
      console.log = origLog;

      jobs.set(jobId, { status: "complete", step: 15, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jobs.set(jobId, { status: "failed", step: 0, error: msg });
    }
  })();

  return NextResponse.json({ job_id: jobId });
});
