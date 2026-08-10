import { demoSeed } from "@/lib/demo-data";

export const dynamic = "force-static";

export async function GET() {
  return Response.json({
    mode: "seeded-demo",
    seedVersion: demoSeed.seedVersion,
    data: demoSeed,
  });
}
