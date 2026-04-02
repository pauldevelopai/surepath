import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { jobs } from "@/app/api/generate/route";

export const GET = withAuth(async (req: NextRequest) => {
  const jobId = req.nextUrl.searchParams.get("job_id");
  if (!jobId) return NextResponse.json({ error: "Missing job_id" }, { status: 400 });

  const job = jobs.get(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json(job);
});
