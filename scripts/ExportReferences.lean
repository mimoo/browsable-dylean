import Lean
import Lean.Server.References

open Lean

def main (args : List String) : IO UInt32 := do
  let [file, moduleName, output] := args
    | throw <| IO.userError "Expected source file, module name, output file"
  unsafe enableInitializersExecution
  initSearchPath (← findSysroot)
  let input ← IO.FS.readFile file
  let inputCtx := Parser.mkInputContext input file
  let opts := Elab.async.set (internal.cmdlineSnapshots.set {} true) true
  let snap ← Language.Lean.process (fun header => pure <| .ok {
    imports := header.imports
    isModule := header.isModule
    mainModuleName := moduleName.toName
    opts := opts
  }) none { inputCtx with }
  let snaps := Language.toSnapshotTree snap
  let errors ← snaps.runAndReport opts false {}
  if errors then return 1
  let trees := snaps.getAll.flatMap (match ·.infoTree? with | some t => #[t] | _ => #[])
  let (refs, _) ← (Server.findModuleRefs inputCtx.fileMap trees).toLspModuleRefs
  let some state := Language.Lean.waitForFinalCmdState? snap
    | throw <| IO.userError "No final command state"
  let mut decls : Lsp.Decls := {}
  for (name, _) in state.env.constants.toList do
    if (state.env.getModuleIdxFor? name).isNone then
      if let some ranges := declRangeExt.find? state.env name then
        decls := decls.insert name.toString (.ofDeclarationRanges ranges)
  IO.FS.writeFile output (Json.mkObj [("references", toJson refs), ("decls", toJson decls)]).compress
  return 0
