// Native identity-handle regression fixture. No credentials or provider calls.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Migan.Native;

public static class HandleRegression {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr payload, uint timeout);
  static string Exe { get { return Assembly.GetExecutingAssembly().Location; } }
  static void Require(bool value, string message) { if (!value) throw new Exception(message); }
  sealed class Capture : Stream {
    readonly MemoryStream bytes = new MemoryStream();
    public readonly ManualResetEvent Line = new ManualResetEvent(false);
    public override void Write(byte[] b, int offset, int count) {
      lock (bytes) { bytes.Write(b, offset, count); for (int i = offset; i < offset + count; i++) if (b[i] == 10) Line.Set(); }
    }
    public string Text { get { lock (bytes) return Encoding.UTF8.GetString(bytes.ToArray()); } }
    public override bool CanRead { get { return false; } } public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } } public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() {} public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
    public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); } public override void SetLength(long n) { throw new NotSupportedException(); }
  }
  static IntPtr Retain(uint pid, bool allowTerminate = false) {
    IntPtr handle = OpenProcess((uint)(0x100000 | 0x1000 | (allowTerminate ? 0x1 : 0)), false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Retain fixture process");
    long created, exited, kernel, user;
    Require(GetProcessTimes(handle, out created, out exited, out kernel, out user), "Exact handle creation identity unavailable");
    Require(created != 0 && WaitForSingleObject(handle, 0) == 258, "Fixture must be live before stop");
    return handle;
  }
  static int Target(string mode) {
    if (mode == "missed") {
      var brief = new ProcessStartInfo(Exe, "--exit-fast"); brief.UseShellExecute = false; brief.CreateNoWindow = true;
      using (Process completed = Process.Start(brief)) { Require(completed.WaitForExit(4000), "Short-lived member fixture deadline"); }
    }
    var start = new ProcessStartInfo(Exe, "--leaf");
    start.UseShellExecute = false; start.CreateNoWindow = true;
    start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
    Process leaf = Process.Start(start);
    Console.WriteLine("TREE:" + Process.GetCurrentProcess().Id + ":" + leaf.Id); Console.Out.Flush();
    if (mode == "ignore") { Thread.Sleep(Timeout.Infinite); return 9; }
    Require(Console.ReadLine() == "exit", "Fixture input differs");
    // Deliberately no newline, to verify separation of proof from final target stderr.
    Console.Error.Write("utf8-\u00e9\u2615"); Console.Error.Flush();
    return 17;
  }
  static void RunCase(string kind) {
    IntPtr parent = IntPtr.Zero, leaf = IntPtr.Zero;
    using (var tree = new NativeJobTree()) {
      var output = new Capture(); var error = new Capture();
      try {
        tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, WorkingDirectory = Path.GetDirectoryName(Exe),
          Arguments = new[] { "--target", kind == "blocked-input-eof" ? "ignore" : "read" }, PipeInput = true });
        tree.StartOutputPumps(output, error);
        Require(output.Line.WaitOne(4000), "Target handshake deadline");
        string[] identities = output.Text.Trim().Split(':');
        Require(identities.Length == 3 && identities[0] == "TREE", "Target handshake malformed");
        parent = Retain(UInt32.Parse(identities[1])); leaf = Retain(UInt32.Parse(identities[2]));
        if (kind == "natural") {
          byte[] request = Encoding.UTF8.GetBytes("exit\n"); tree.Input.Write(request, 0, request.Length); tree.Input.Flush();
        } else if (kind == "blocked-input-eof") {
          // 128 KiB fits the queue; the target never reads stdin. Reader must still reach EOF.
          tree.StartInputRelay(new MemoryStream(new byte[128 * 1024], false));
        } else tree.RequestStop();
        NativeJobTree.DrainResult result = tree.WaitAndDrain(5000);
        uint parentState = WaitForSingleObject(parent, 0), leafState = WaitForSingleObject(leaf, 0);
        Console.WriteLine("OBSERVE " + kind + " accounting=" + result.ActiveProcesses + " total=" + result.TotalProcesses +
          " retained=" + result.RetainedProcessHandles + " retired=" + result.RetiredProcesses + " gone=" + result.GoneProcessNotifications +
          " parentWait=" + parentState + " grandchildWait=" + leafState);
        // No sleep/retry here: the exact handles were held before shutdown began.
        Require(parentState == 0, "Parent handle not signaled at completion");
        Require(leafState == 0, "Grandchild handle not signaled at completion");
        Require(result.ActiveProcesses == 0 && result.DrainMilliseconds <= 5000, "Drain result invalid");
        Require(result.RelayFailure == null, "Unexpected relay failure: " + result.RelayFailure);
        string nonce = Guid.NewGuid().ToString(); var proof = new StringWriter();
        tree.WriteDrainedProof(nonce, proof);
        string separator = error.Text.Length > 0 && !error.Text.EndsWith("\n") ? Environment.NewLine : "";
        Require(proof.ToString() == separator + "MIGANGO_JOB_DRAINED:" + nonce + Environment.NewLine, "Completion proof framing");
        bool duplicateBlocked = false; try { tree.WriteDrainedProof(nonce, proof); } catch (InvalidOperationException) { duplicateBlocked = true; }
        Require(duplicateBlocked, "Duplicate proof accepted");
        if (kind == "natural") {
          Require(result.TargetExitCode == 17, "Natural target exit code changed");
          Require(error.Text == "utf8-\u00e9\u2615", "Raw UTF-8 stderr changed");
        }
        Console.WriteLine("PASS " + kind + " drainMs=" + result.DrainMilliseconds + " parentSignaled=true grandchildSignaled=true");
      } finally {
        if (parent != IntPtr.Zero) CloseHandle(parent);
        if (leaf != IntPtr.Zero) CloseHandle(leaf);
      }
    }
  }
  static void EofBeforeLaunch() {
    using(var tree = new NativeJobTree()) {
      tree.StartInputRelay(new MemoryStream(new byte[0], false));
      var stopping = typeof(NativeJobTree).GetField("stopping", BindingFlags.Instance | BindingFlags.NonPublic);
      Require(SpinWait.SpinUntil(delegate { return (bool)stopping.GetValue(tree); }, 4000), "EOF was not observed before launch");
      tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--leaf" }, PipeInput = true });
      var result = tree.WaitAndDrain(5000);
      Require(result.StopRequested && !result.TargetCreated, "Observed prelaunch EOF must prevent target creation");
      Console.WriteLine("PASS eof-before-launch targetCreated=false externalStop=true");
    }
  }
  static void StopAfterExit() {
    using(var tree = new NativeJobTree()) {
      tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--exit-fast" } });
      tree.StartOutputPumps(Stream.Null, Stream.Null);
      Require(WaitForSingleObject(tree.ProcessHandle, 4000) == 0, "Fixture target did not exit");
      tree.RequestStop();
      var result = tree.WaitAndDrain(5000);
      Require(result.StopRequested, "External Stop must survive racing natural target exit");
      Console.WriteLine("PASS stop-after-exit externalStop=true");
    }
  }
  static void StopBeforeLaunch() {
    using (var tree = new NativeJobTree()) {
      tree.RequestStop(); tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--leaf" } });
      var result = tree.WaitAndDrain(5000);
      Require(!result.TargetCreated && tree.ProcessId == 0 && result.ActiveProcesses == 0, "Stop-before-launch created target");
      Console.WriteLine("PASS stop-before-launch targetCreated=false");
    }
  }
  static void AttestationFailure() {
    IntPtr retained = IntPtr.Zero; bool refused = false, proofRefused = false;
    var tree = new NativeJobTree();
    try {
      try {
        tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--leaf" },
          AttestSuspended = delegate(IntPtr handle) { retained = Retain(tree.ProcessId); throw new InvalidOperationException("fixture attestation rejection"); } });
      } catch (InvalidOperationException e) { refused = e.Message == "fixture attestation rejection"; }
      try { tree.WriteDrainedProof(Guid.NewGuid().ToString(), new StringWriter()); } catch (InvalidOperationException) { proofRefused = true; }
      tree.Dispose();
      Require(refused && proofRefused && retained != IntPtr.Zero, "Attestation failure did not fail closed");
      Require(WaitForSingleObject(retained, 0) == 0, "Suspended target not signaled when exception cleanup returned");
      Require(tree.ExceptionalProcessDrainConfirmed && !tree.IsDrained, "Exception cleanup must confirm process drain without granting success proof");
      Console.WriteLine("PASS attestation-failure targetSignaled=true proofRefused=true");
    } finally { tree.Dispose(); if (retained != IntPtr.Zero) CloseHandle(retained); }
  }
  static int SuspendedBroker() {
    using (var tree = new NativeJobTree()) {
      tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--leaf" },
        AttestSuspended = delegate(IntPtr handle) {
          Console.WriteLine("SUSPENDED:" + tree.ProcessId); Console.Out.Flush();
          Console.ReadLine(); // The outer fixture kills this supervisor at this exact barrier.
          throw new InvalidOperationException("Crash fixture was unexpectedly released");
        } });
    }
    return 9;
  }
  static void CrashBeforeResume() {
    IntPtr retained = IntPtr.Zero;
    var start = new ProcessStartInfo(Exe, "--suspended-broker");
    start.UseShellExecute = false; start.CreateNoWindow = true;
    start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
    using (Process broker = Process.Start(start)) {
      try {
        var read = System.Threading.Tasks.Task.Factory.StartNew(delegate { return broker.StandardOutput.ReadLine(); });
        Require(read.Wait(4000), "Suspended broker handshake deadline");
        string line = read.Result;
        Require(line != null && line.StartsWith("SUSPENDED:"), "Suspended broker handshake invalid");
        retained = Retain(UInt32.Parse(line.Substring("SUSPENDED:".Length)));
        broker.Kill(); Require(broker.WaitForExit(5000), "Owned broker crash deadline");
        Require(WaitForSingleObject(retained, 5000) == 0, "Suspended target orphaned by broker crash");
        Console.WriteLine("PASS crash-before-resume targetSignaled=true atomicMembership=true");
      } finally {
        if (!broker.HasExited) { broker.Kill(); broker.WaitForExit(5000); }
        if (retained != IntPtr.Zero) CloseHandle(retained);
      }
    }
  }
  static void ShortLivedCoverage(bool loseNotifications) {
    using (var tree = new NativeJobTree()) {
      var output = new Capture();
      tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--target", "missed" }, PipeInput = true });
      tree.StartOutputPumps(output, Stream.Null);
      Require(output.Line.WaitOne(4000), "Coverage fixture handshake deadline");
      // No supervision snapshots occur until the target has exited its brief member.
      if (loseNotifications) {
        // Fault injection is confined to this fixture: consume pending notifications privately.
        // No production environment flag, delegate, or branch enables this path.
        IntPtr port = (IntPtr)typeof(NativeJobTree).GetField("completionPort", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(tree);
        uint message; UIntPtr key; IntPtr payload;
        while (GetQueuedCompletionStatus(port, out message, out key, out payload, 0)) { }
        Require(Marshal.GetLastWin32Error() == 258, "Unexpected simulated-loss port error");
      }
      tree.RequestStop(); bool refused = false;
      NativeJobTree.DrainResult result = null;
      try { result = tree.WaitAndDrain(5000); } catch (TimeoutException e) { refused = e.Message.Contains("coverage"); }
      if (loseNotifications) {
        Require(refused && !tree.IsDrained, "Unobserved lifetime member must prevent completion proof");
        Console.WriteLine("PASS missing-coverage proofRefused=true");
      } else {
        Require(!refused && tree.IsDrained && result.GoneProcessNotifications >= 1, "Short-lived member notification was not covered");
        Require(result.TotalProcesses == result.RetainedProcessHandles + result.RetiredProcesses + result.GoneProcessNotifications, "Coverage certificate mismatch");
        Console.WriteLine("PASS short-lived-coverage total=" + result.TotalProcesses + " retired=" + result.RetiredProcesses + " gone=" + result.GoneProcessNotifications);
      }
    }
  }
  static void ResolveCommands() {
    string folder = Path.GetDirectoryName(Exe);
    Require(NativeJobTree.ResolveExecutable(Path.GetFileName(Exe), folder) == Exe, "Basename resolver changed path");
    Require(NativeJobTree.ResolveExecutable(Path.GetFileNameWithoutExtension(Exe), folder) == Exe, "Extension resolver changed path");
    Require(NativeJobTree.ResolveExecutable(".\\" + Path.GetFileName(Exe), folder) == Exe, "Relative resolver changed path");
    bool refused = false; try { NativeJobTree.ResolveExecutable("fixture.cmd", folder); } catch (ArgumentException) { refused = true; }
    Require(refused, "Batch fallback was not refused");
    Console.WriteLine("PASS resolve-executable basename=true extension=true relative=true batchRefused=true");
  }
  static void ProofOutputFraming() {
    foreach (string mode in new[] { "empty", "line", "partial" }) {
      using (var tree = new NativeJobTree()) {
        var captured = new MemoryStream();
        tree.Launch(new NativeJobTree.LaunchOptions { Executable = Exe, Arguments = new[] { "--stderr", mode } });
        tree.StartOutputPumps(Stream.Null, captured); tree.WaitAndDrain(5000);
        var proof = new StringWriter(); string nonce = Guid.NewGuid().ToString(); tree.WriteDrainedProof(nonce, proof);
        string expected = (mode == "partial" ? Environment.NewLine : "") + "MIGANGO_JOB_DRAINED:" + nonce + Environment.NewLine;
        Require(proof.ToString() == expected, "Native control framing injected an unnecessary output newline: " + mode);
        string raw = Encoding.UTF8.GetString(captured.ToArray());
        Require(raw == (mode == "empty" ? "" : mode == "line" ? "child-error\n" : "child-error"), "Child stderr bytes changed");
      }
    }
    Console.WriteLine("PASS proof-output-framing empty=true newline=true partialSeparator=true rawBytes=true");
  }
  static int BarrierBroker(string release, uint observerPid, string exitedEvent) {
    IntPtr observer=Retain(observerPid);
    try { using(var barrierExited=EventWaitHandle.OpenExisting(exitedEvent)) using(var tree=new NativeJobTree()) {
      tree.StartEofMonitor(Console.OpenStandardInput());
      tree.Launch(new NativeJobTree.LaunchOptions { Executable=Exe, Arguments=new[]{"--leaf"},
        AttestSuspended=delegate(IntPtr handle) {
          Console.WriteLine("BARRIER:"+Process.GetCurrentProcess().Id+":"+tree.ProcessId);Console.Out.Flush();
          try { var barrier=Stopwatch.StartNew();
          while(!File.Exists(release)) {
            Require(WaitForSingleObject(observer,0)==258,"Barrier observer exited");
            Require(barrier.ElapsedMilliseconds<4000,"Owned fixture barrier deadline");
            Thread.Sleep(1);
          }
          } finally { barrierExited.Set(); }
        } });
      tree.StartOutputPumps(Stream.Null,Stream.Null);tree.WaitAndDrain(5000);
    } } finally { CloseHandle(observer); }
    return 125;
  }
  static void HostJobBoundary(string node) {
    string script=Path.Combine(Path.GetDirectoryName(Exe),"host-job.mjs");
    File.WriteAllText(script,"import fs from 'node:fs';import {spawn} from 'node:child_process';const trace=process.argv[3]+'.trace';const c=spawn(process.argv[2],['--barrier-broker',process.argv[3],process.argv[5],process.argv[6]],{detached:process.argv[4]==='true',windowsHide:true,stdio:['pipe','pipe','pipe']});c.stdout.pipe(process.stdout);c.stderr.on('data',b=>fs.appendFileSync(trace,b));c.on('error',e=>fs.appendFileSync(trace,'SPAWN:'+e.code));c.on('exit',code=>fs.appendFileSync(trace,'EXIT:'+code));setInterval(()=>{},1000);",new UTF8Encoding(false));
    foreach(bool detached in new[]{false,true}) {
      string release=Path.Combine(Path.GetDirectoryName(Exe),"release-"+Guid.NewGuid().ToString("N"));
      string exitedEvent="Local\\migango-fixture-"+Guid.NewGuid().ToString("N");
      var start=new ProcessStartInfo(node,NativeJobTree.Quote(script)+" "+NativeJobTree.Quote(Exe)+" "+NativeJobTree.Quote(release)+" "+(detached?"true":"false")+" "+Process.GetCurrentProcess().Id+" "+NativeJobTree.Quote(exitedEvent));
      start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
      IntPtr broker=IntPtr.Zero,target=IntPtr.Zero;
      using(var barrierExited=new EventWaitHandle(false,EventResetMode.ManualReset,exitedEvent)) using(Process host=Process.Start(start)) {
        try {
          var read=System.Threading.Tasks.Task.Factory.StartNew(delegate{return host.StandardOutput.ReadLine();});
          Require(read.Wait(4000),"Host/native barrier handshake deadline: "+(File.Exists(release+".trace")?File.ReadAllText(release+".trace"):"no stderr"));string line=read.Result;
          Require(line!=null&&line.StartsWith("BARRIER:"),"Host/native barrier malformed");string[] ids=line.Split(':');
          broker=Retain(UInt32.Parse(ids[1]),true);target=Retain(UInt32.Parse(ids[2]));
          Require(WaitForSingleObject(broker,0)==258&&WaitForSingleObject(target,0)==258,"Both exact handles must be alive before host crash");
          host.Kill();Require(host.WaitForExit(5000),"Owned host crash deadline");
          if(!detached) {
            Require(WaitForSingleObject(broker,5000)==0,"Non-detached broker must demonstrate host libuv Job kill before barrier release");
            Require(!File.Exists(release),"Barrier was released prematurely");
            Require(!barrierExited.WaitOne(0),"Attached broker exited its barrier voluntarily instead of host Job kill");
            Require(WaitForSingleObject(target,5000)==0,"Atomic Job crash fallback failed");
          } else {
            Require(WaitForSingleObject(broker,100)==258,"Detached broker died in host Job before controlled drain");
            File.WriteAllText(release,"release");Require(WaitForSingleObject(broker,5000)==0,"Detached broker failed to finish EOF drain");
            Require(WaitForSingleObject(target,0)==0,"Target handle not signaled at detached supervisor exit");
            Require(barrierExited.WaitOne(0),"Detached broker did not leave its barrier for controlled drain");
          }
          Console.WriteLine("OBSERVE host-job detached="+detached+" brokerExited=true targetSignaled=true");
        } finally {
          if(!host.HasExited){host.Kill();host.WaitForExit(5000);}
          if(broker!=IntPtr.Zero){try{if(WaitForSingleObject(broker,0)==258){File.WriteAllText(release,"cleanup");if(WaitForSingleObject(broker,5000)==258){Require(TerminateProcess(broker,125),"Owned broker fallback terminate failed");Require(WaitForSingleObject(broker,5000)==0,"Owned broker fallback termination unconfirmed");}}}finally{CloseHandle(broker);}}
          if(target!=IntPtr.Zero){WaitForSingleObject(target,5000);CloseHandle(target);}
        }
      }
    }
    Console.WriteLine("PASS host-job-boundary attachedKilledBeforeBarrier=true detachedDrainedBeforeExit=true");
  }
  public static int Main(string[] args) {
    try {
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});
      Console.SetError(new StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false)){AutoFlush=true});
      Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false),false,1024,true));
      if (args.Length > 0 && args[0] == "--leaf") { Thread.Sleep(Timeout.Infinite); return 0; }
      if (args.Length > 0 && args[0] == "--exit-fast") return 0;
      if (args.Length > 1 && args[0] == "--stderr") { if(args[1] != "empty") Console.Error.Write(args[1] == "line" ? "child-error\n" : "child-error"); return 0; }
      if (args.Length > 0 && args[0] == "--target") return Target(args[1]);
      if (args.Length > 0 && args[0] == "--suspended-broker") return SuspendedBroker();
      if(args.Length==4&&args[0]=="--barrier-broker")return BarrierBroker(args[1],UInt32.Parse(args[2]),args[3]);
      if(args.Length==2&&args[0]=="host-job-boundary"){HostJobBoundary(args[1]);return 0;}
      if (args.Length != 1) throw new ArgumentException("Choose natural, stop, blocked-input-eof, stop-before-launch, attestation-failure, or crash-before-resume");
      if (args[0] == "eof-before-launch") EofBeforeLaunch();
      else if (args[0] == "stop-after-exit") StopAfterExit();
      else if (args[0] == "stop-before-launch") StopBeforeLaunch();
      else if (args[0] == "attestation-failure") AttestationFailure();
      else if (args[0] == "crash-before-resume") CrashBeforeResume();
      else if (args[0] == "missing-coverage") ShortLivedCoverage(true);
      else if (args[0] == "short-lived-coverage") ShortLivedCoverage(false);
      else if (args[0] == "resolve-executable") ResolveCommands();
      else if (args[0] == "proof-output-framing") ProofOutputFraming();
      else if (args[0] == "natural" || args[0] == "stop" || args[0] == "blocked-input-eof") RunCase(args[0]);
      else throw new ArgumentException("Unknown fixture case");
      return 0;
    } catch (Exception e) { Console.Error.WriteLine("FAIL " + e.GetType().Name + ": " + e.Message); return 1; }
  }
}
