import { prisma } from "@/lib/prisma";
import { route } from "@/lib/route";

/** An auto-apply attempt's screenshot: the form as filled in (?of=form), or the page after submit (?of=confirmation). */
export const GET = route<RouteContext<"/api/apply/[id]/screenshot">>(async (request, { params }) => {
  const { id } = await params;
  const confirmation = new URL(request.url).searchParams.get("of") === "confirmation";
  const attempt = await prisma.applyAttempt.findUnique({ where: { id }, select: { screenshot: !confirmation, confirmation } });
  const image = confirmation ? attempt?.confirmation : attempt?.screenshot;
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } });
});
