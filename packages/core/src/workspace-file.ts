/** A portable repository-relative file path used by planned delivery. */
export function isWorkspaceFilePath(path: string): boolean {
  if (!path || path.length > 500) return false;
  return path.split('/').every((part) =>
    part.length > 0 && part.length <= 240 &&
    !/[<>:"\\|?*\x00-\x1f\x7f]/.test(part) && !/[ .]$/.test(part) &&
    !/^\s/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    !/^(?:\.git|\.workflow-orchestrator)$/i.test(part),
  );
}
