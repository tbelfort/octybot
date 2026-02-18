/**
 * Unified shell execution helper.
 * Used by service.ts and deploy.ts.
 */

export async function run(
  cmd: string[],
  opts: { cwd?: string; timeout?: number; label?: string } = {}
): Promise<{ exitCode: number; ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return {
    exitCode,
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
