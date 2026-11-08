// Owner-supervised native process-tree custody.
// Compile with the worker entry point under .NET Framework 4.x / C# 5.
namespace Migan.Native {
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

  public sealed class NativeJobTree : IDisposable {
    public sealed class AttributeValue {
      public IntPtr Key, Value, Size;
      // The caller keeps Value alive until Launch returns. It owns its memory.
      public AttributeValue(IntPtr key, IntPtr value, IntPtr size) {
        Key = key; Value = value; Size = size;
      }
    }
    public sealed class LaunchOptions {
      public string Executable, WorkingDirectory;
      public string[] Arguments = new string[0];
      // null inherits only the supervisor's already-filtered environment.
      public IDictionary<string, string> Environment;
      public bool PipeInput;
      public uint ProcessLimit;
      public ulong JobMemoryBytes;
      public AttributeValue[] ExtraAttributes = new AttributeValue[0];
      // AppContainer token attestation belongs here, before any target instruction.
      public Action<IntPtr> AttestSuspended;
    }
    public sealed class DrainResult {
      public uint TargetExitCode, ActiveProcesses, TotalProcesses;
      public int RetainedProcessHandles, RetiredProcesses, GoneProcessNotifications;
      public bool TargetCreated, StopRequested;
      public long DrainMilliseconds;
      public string RelayFailure;
    }

    [StructLayout(LayoutKind.Sequential)] struct SA {
      public int Size; public IntPtr Descriptor;
      [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {
      public int Size; public string Reserved, Desktop, Title;
      public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
      public ushort Show, ReservedCount;
      public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
      public long ProcessTime, JobTime; public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
      public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct EXT {
      public BASIC Basic; public IO Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
      public long User, Kernel, PeriodUser, PeriodKernel;
      public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct PORT { public IntPtr Key, Handle; }
    sealed class ProcessRecord {
      public uint Pid; public long Created; public IntPtr Handle; public bool NewSeen, Retired;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, int size, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryJobProcessList(IntPtr job, int kind, IntPtr info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint concurrency);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr payload, uint timeout);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    static extern bool AssociateCompletionPort(IntPtr job, int kind, ref PORT port, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string path, uint access, uint share, ref SA security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr old, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
      bool inherit, uint flags, IntPtr environment, string directory, ref SIX startup, out PI process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint SearchPath(string searchPath, string file, string extension, uint capacity, StringBuilder result, out IntPtr filePart);

    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258;
    readonly int owner = Thread.CurrentThread.ManagedThreadId;
    readonly object resumeGate = new object();
    readonly ManualResetEvent stop = new ManualResetEvent(false);
    IntPtr job, process, completionPort;
    uint processId;
    bool launched, drained, disposed, proofWritten;
    volatile bool stopping, externalStopRequested;
    string relayFailure;
    FileStream input, output, error;
    Thread outputThread, errorThread, inputReader, inputWriter;
    BlockingCollection<byte[]> inputQueue;
    DrainResult result;
    readonly Dictionary<string, ProcessRecord> observed = new Dictionary<string, ProcessRecord>();
    readonly Dictionary<uint, ProcessRecord> heldByPid = new Dictionary<uint, ProcessRecord>();
    int goneNotifications, retiredProcesses, stderrLastByte = -1;
    Stopwatch drainClock;
    int drainBudget;
    public bool ExceptionalProcessDrainConfirmed { get; private set; }
    public string ExceptionalDrainFailure { get; private set; }

    public uint ProcessId { get { return processId; } }
    // Borrowed exact kernel handle. The core owns it until Dispose.
    public IntPtr ProcessHandle { get { return process; } }
    public Stream Input { get { return input; } }
    public Stream Output { get { return output; } }
    public Stream Error { get { return error; } }
    public bool IsDrained { get { return drained; } }

    static void Check(bool ok, string operation) {
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    void Owner() {
      if (owner != Thread.CurrentThread.ManagedThreadId) throw new InvalidOperationException("Job lifecycle needs its single owner thread");
      if (disposed) throw new ObjectDisposedException("NativeJobTree");
    }
    static void Close(ref IntPtr handle) {
      IntPtr value = handle; handle = IntPtr.Zero;
      if (value != IntPtr.Zero && value != new IntPtr(-1)) CloseHandle(value);
    }
    static FileStream Take(ref IntPtr handle, FileAccess access) {
      var safe = new SafeFileHandle(handle, true); handle = IntPtr.Zero;
      try { return new FileStream(safe, access, 4096, false); }
      catch { safe.Dispose(); throw; }
    }
    public static string Quote(string value) {
      if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid command argument");
      var text = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append('"'); slashes = 0; continue; }
        text.Append('\\', slashes); slashes = 0; text.Append(c);
      }
      text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    static IntPtr EnvironmentBlock(IDictionary<string, string> values) {
      if (values == null) return IntPtr.Zero;
      var sorted = new SortedDictionary<string, string>(values, StringComparer.OrdinalIgnoreCase);
      var text = new StringBuilder();
      foreach (var item in sorted) {
        if (String.IsNullOrEmpty(item.Key) || item.Key.IndexOfAny(new[] { '=', '\0' }) >= 0 ||
            item.Value == null || item.Value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid environment entry");
        text.Append(item.Key).Append('=').Append(item.Value).Append('\0');
      }
      text.Append('\0'); if (sorted.Count == 0) text.Append('\0');
      return Marshal.StringToHGlobalUni(text.ToString());
    }
    public static string ResolveExecutable(string command, string workingDirectory) {
      if (String.IsNullOrWhiteSpace(command) || command.IndexOfAny(new[] { '\0', '"', '\r', '\n' }) >= 0)
        throw new ArgumentException("Invalid executable name");
      string extension = Path.GetExtension(command);
      if (String.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase) ||
          String.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("Batch files require a separate approved shell policy");
      if (!Path.IsPathRooted(command) && (command.IndexOf('\\') >= 0 || command.IndexOf('/') >= 0))
        command = Path.GetFullPath(Path.Combine(workingDirectory ?? Directory.GetCurrentDirectory(), command));
      int capacity = 512;
      while (capacity <= 32768) {
        var resolved = new StringBuilder(capacity); IntPtr filePart;
        uint needed = SearchPath(null, command, extension.Length == 0 ? ".exe" : null,
          (uint)capacity, resolved, out filePart);
        Check(needed != 0, "Resolve executable");
        if (needed < capacity) {
          string path = resolved.ToString();
          if (!Path.IsPathRooted(path)) throw new InvalidOperationException("Executable resolution was not absolute");
          return Path.GetFullPath(path);
        }
        capacity = checked((int)needed + 1);
      }
      throw new PathTooLongException("Executable resolution limit exceeded");
    }
    static void Attribute(IntPtr list, IntPtr key, IntPtr value, IntPtr size) {
      Check(UpdateProcThreadAttribute(list, 0, key, value, size, IntPtr.Zero, IntPtr.Zero), "Startup attribute");
    }

    public void RequestStop() {
      // This lock only covers the final stop/resume decision, never a pipe write.
      lock (resumeGate) { externalStopRequested = true; stopping = true; stop.Set(); }
    }
    void StopForDrain() {
      lock (resumeGate) { stopping = true; stop.Set(); }
    }
    void RelayFailed(string operation) {
      Interlocked.CompareExchange(ref relayFailure, operation, null);
      RequestStop();
    }

    public void Launch(LaunchOptions options) {
      Owner(); if (launched) throw new InvalidOperationException("Launch is one-shot"); launched = true;
      if (options == null || String.IsNullOrEmpty(options.Executable) || !Path.IsPathRooted(options.Executable))
        throw new ArgumentException("Use the approved absolute executable path");
      IntPtr attrs = IntPtr.Zero, jobList = IntPtr.Zero, handleList = IntPtr.Zero, env = IntPtr.Zero;
      IntPtr childInput = IntPtr.Zero, inputWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
      IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero; PI pi = new PI(); bool attrsReady = false;
      try {
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create job");
        Check(SetHandleInformation(job, 1, 0), "Noninheritable job handle");
        EXT limits = new EXT(); limits.Basic.Flags = 0x2000;
        if (options.ProcessLimit != 0) { limits.Basic.Flags |= 0x8; limits.Basic.ActiveLimit = options.ProcessLimit; }
        if (options.JobMemoryBytes != 0) { limits.Basic.Flags |= 0x200; limits.JobMemory = new UIntPtr(options.JobMemoryBytes); }
        Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(EXT))), "Job limits");
        completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        Check(completionPort != IntPtr.Zero, "Private Job completion port");
        Check(SetHandleInformation(completionPort, 1, 0), "Noninheritable completion port");
        PORT port = new PORT(); port.Key = job; port.Handle = completionPort;
        Check(AssociateCompletionPort(job, 7, ref port, Marshal.SizeOf(typeof(PORT))), "Associate Job completion port");
        if (stopping) return;
        SA sa = new SA(); sa.Size = Marshal.SizeOf(typeof(SA)); sa.Inherit = true;
        Check(CreatePipe(out outRead, out outWrite, ref sa, 0), "Output pipe");
        Check(CreatePipe(out errRead, out errWrite, ref sa, 0), "Error pipe");
        Check(SetHandleInformation(outRead, 1, 0) && SetHandleInformation(errRead, 1, 0), "Noninheritable readers");
        if (options.PipeInput) {
          Check(CreatePipe(out childInput, out inputWrite, ref sa, 0), "Input pipe");
          Check(SetHandleInformation(inputWrite, 1, 0), "Noninheritable input writer");
        } else {
          childInput = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
          Check(childInput != new IntPtr(-1), "NUL input");
        }
        int count = 2 + options.ExtraAttributes.Length; IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
        Check(size != IntPtr.Zero, "Attribute list size"); attrs = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(attrs, count, 0, ref size), "Attribute list"); attrsReady = true;
        jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
        Attribute(attrs, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size)); // JOB_LIST
        handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
        Marshal.WriteIntPtr(handleList, 0, childInput); Marshal.WriteIntPtr(handleList, IntPtr.Size, outWrite);
        Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errWrite);
        Attribute(attrs, new IntPtr(0x20002), handleList, new IntPtr(IntPtr.Size * 3)); // HANDLE_LIST
        foreach (var item in options.ExtraAttributes) {
          if (item.Key == new IntPtr(0x2000D) || item.Key == new IntPtr(0x20002) || item.Key == new IntPtr(0x20000))
            throw new ArgumentException("Caller cannot override job, handles, or parent process");
          Attribute(attrs, item.Key, item.Value, item.Size);
        }
        SIX startup = new SIX(); startup.Startup.Size = Marshal.SizeOf(typeof(SIX)); startup.Startup.Flags = 0x100;
        startup.Startup.Input = childInput; startup.Startup.Output = outWrite; startup.Startup.Error = errWrite;
        startup.Attributes = attrs; env = EnvironmentBlock(options.Environment);
        var command = new StringBuilder(Quote(options.Executable));
        foreach (string arg in options.Arguments) command.Append(' ').Append(Quote(arg));
        // Job membership is applied by CreateProcess itself, before it returns.
        // No suspended child can exist outside this job after successful creation.
        Check(CreateProcess(options.Executable, command, IntPtr.Zero, IntPtr.Zero, true,
          0x80000 | 4 | 0x400 | 0x08000000, env, options.WorkingDirectory, ref startup, out pi), "Atomic job process");
        process = pi.Process; pi.Process = IntPtr.Zero; processId = pi.Pid;
        RecordHandle(processId, process, false);
        bool member; Check(IsProcessInJob(process, job, out member), "Verify job membership");
        if (!member) throw new InvalidOperationException("Atomic job membership missing");
        if (options.AttestSuspended != null) options.AttestSuspended(process);
        PumpNotifications();
        Close(ref childInput); Close(ref outWrite); Close(ref errWrite);
        output = Take(ref outRead, FileAccess.Read); error = Take(ref errRead, FileAccess.Read);
        if (options.PipeInput) input = Take(ref inputWrite, FileAccess.Write);
        if (inputQueue != null && input != null) StartInputWriter();
        lock (resumeGate) {
          if (!stopping) {
            uint previous = ResumeThread(pi.Thread);
            Check(previous != UInt32.MaxValue, "Resume target");
            if (previous != 1) throw new InvalidOperationException("Unexpected target suspend count");
          }
        }
      } catch {
        RequestStop();
        // The caller must not emit success. Job close in Dispose remains the crash fallback.
        if (job != IntPtr.Zero) { BeginDrainBudget(5000); TerminateJobObject(job, 125); }
        throw;
      } finally {
        Close(ref pi.Thread); Close(ref pi.Process);
        Close(ref childInput); Close(ref inputWrite); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite);
        if (attrsReady) DeleteProcThreadAttributeList(attrs);
        foreach (IntPtr p in new[] { attrs, jobList, handleList, env }) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
      }
    }

    Thread Pump(FileStream source, Stream destination, string name) {
      var thread = new Thread(delegate() {
        try {
          byte[] buffer = new byte[4096]; int n;
          while ((n = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, n); destination.Flush();
            if (name == "stderr-relay") stderrLastByte = buffer[n - 1];
          }
        } catch { RelayFailed(name); }
        finally { source.Dispose(); }
      });
      thread.IsBackground = true; thread.Start(); return thread;
    }
    public void StartOutputPumps(Stream standardOutput, Stream standardError) {
      Owner(); if (outputThread != null || errorThread != null) throw new InvalidOperationException("Output relay already started");
      if (output != null) outputThread = Pump(output, standardOutput, "stdout-relay");
      if (error != null) errorThread = Pump(error, standardError, "stderr-relay");
    }
    public void StartInputRelay(Stream hostInput) {
      Owner(); if (inputReader != null || (launched && input == null)) throw new InvalidOperationException("Input relay unavailable");
      // Reader never waits for child stdin. Overflow fails closed instead of growing memory.
      // Four MiB admits a full existing two-MiB MCP frame plus concurrent input.
      inputQueue = new BlockingCollection<byte[]>(1024);
      inputReader = new Thread(delegate() {
        try {
          while (!stopping) {
            byte[] buffer = new byte[4096]; int n = hostInput.Read(buffer, 0, buffer.Length);
            if (n == 0) { RequestStop(); break; }
            if (n != buffer.Length) Array.Resize(ref buffer, n);
            if (!inputQueue.TryAdd(buffer)) { RelayFailed("input-queue-limit"); break; }
          }
        } catch { RelayFailed("host-input-relay"); }
        finally { inputQueue.CompleteAdding(); }
      });
      inputReader.IsBackground = true; inputReader.Start();
      if (input != null) StartInputWriter();
    }
    void StartInputWriter() {
      Owner(); if (inputWriter != null) throw new InvalidOperationException("Input writer already started");
      inputWriter = new Thread(delegate() {
        try {
          while (!stopping) {
            byte[] buffer;
            if (inputQueue.TryTake(out buffer, 25)) { input.Write(buffer, 0, buffer.Length); input.Flush(); }
            else if (inputQueue.IsCompleted) break;
          }
        } catch { if (!stopping) RelayFailed("child-input-relay"); }
        finally { input.Dispose(); }
      });
      inputWriter.IsBackground = true; inputWriter.Start();
    }
    public void StartEofMonitor(Stream hostInput) {
      Owner(); if (inputReader != null) throw new InvalidOperationException("Input monitor already started");
      inputReader = new Thread(delegate() {
        try { hostInput.ReadByte(); } catch { RelayFailed("host-control-read"); }
        finally { RequestStop(); }
      });
      inputReader.IsBackground = true; inputReader.Start();
    }
    static bool Signaled(IntPtr handle) {
      uint value = WaitForSingleObject(handle, 0);
      if (value == WAIT_OBJECT_0) return true;
      if (value == WAIT_TIMEOUT) return false;
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Process wait failed");
    }
    static int Remaining(Stopwatch clock, int budget) { return Math.Max(0, budget - (int)clock.ElapsedMilliseconds); }
    void RecordHandle(uint pid, IntPtr handle, bool notification) {
      long created, exited, kernel, user;
      Check(GetProcessTimes(handle, out created, out exited, out kernel, out user), "Retained process creation identity");
      string identity = pid.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" +
        created.ToString(System.Globalization.CultureInfo.InvariantCulture);
      ProcessRecord record;
      if (observed.TryGetValue(identity, out record)) {
        if (notification) record.NewSeen = true;
        if (handle != record.Handle && handle != process) CloseHandle(handle);
        return;
      }
      if (observed.Count + goneNotifications >= 4096)
        throw new InvalidOperationException("Job lifetime observation limit exceeded");
      record = new ProcessRecord { Pid = pid, Created = created, Handle = handle, NewSeen = notification };
      observed.Add(identity, record); heldByPid[pid] = record;
    }
    void ObservePid(uint pid, bool notification) {
      ProcessRecord held;
      if (heldByPid.TryGetValue(pid, out held)) {
        // Holding this exact object prevents PID reuse while a delayed NEW is pending.
        if (notification) held.NewSeen = true;
        return;
      }
      IntPtr handle = OpenProcess(0x100000 | 0x1000, false, pid);
      if (handle == IntPtr.Zero) {
        int failure = Marshal.GetLastWin32Error();
        if (failure == 87) {
          if (notification) {
            // NEW is evidence of one association; a gone PID is an observation, not a swallowed failure.
            if (observed.Count + goneNotifications >= 4096)
              throw new InvalidOperationException("Job lifetime observation limit exceeded");
            goneNotifications++;
          }
          return;
        }
        throw new Win32Exception(failure, "Open exact Job member");
      }
      try {
        bool member; Check(IsProcessInJob(handle, job, out member), "Verify retained Job member");
        if (!member) {
          // A stale PID that now names another process cannot be silently accepted.
          if (notification) throw new InvalidOperationException("Job notification process identity ambiguous");
          return;
        }
        RecordHandle(pid, handle, notification); handle = IntPtr.Zero;
      } finally { Close(ref handle); }
    }
    void PumpNotifications() {
      // Private port, one consumer, bounded per pass. Missing NEW events are caught by lifetime coverage.
      for (int i = 0; i < 4096; i++) {
        uint message; UIntPtr key; IntPtr payload;
        if (!GetQueuedCompletionStatus(completionPort, out message, out key, out payload, 0)) {
          int failure = Marshal.GetLastWin32Error(); if (failure == 258) return;
          throw new Win32Exception(failure, "Read Job completion notification");
        }
        if (key.ToUInt64() != unchecked((ulong)job.ToInt64())) throw new InvalidDataException("Unexpected Job completion key");
        if (message == 6) {
          ulong pid = unchecked((ulong)payload.ToInt64());
          if (pid == 0 || pid > UInt32.MaxValue) throw new InvalidDataException("Job notification PID invalid");
          ObservePid((uint)pid, true);
        }
      }
    }
    void RetireSignaled() {
      foreach (ProcessRecord record in observed.Values) {
        if (record.Retired || !record.NewSeen || !Signaled(record.Handle)) continue;
        record.Retired = true; retiredProcesses++;
        // Root handle remains owned by the core until exit-code inspection and Dispose.
        if (record.Handle != process) {
          heldByPid.Remove(record.Pid);
          IntPtr handle = record.Handle; record.Handle = IntPtr.Zero; Close(ref handle);
        }
      }
    }
    void CaptureMembers() {
      // The total-lifetime accounting count below detects missed short-lived members.
      // Never infer that an unobserved member has finished solely from accounting zero.
      int capacity = 16;
      while (true) {
        int bytes = 8 + capacity * IntPtr.Size; IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try {
          if (!QueryJobProcessList(job, 3, buffer, bytes, IntPtr.Zero)) {
            int failure = Marshal.GetLastWin32Error();
            if (failure == 234 && capacity < 4096) { capacity *= 2; continue; }
            throw new Win32Exception(failure, "Job member capture failed");
          }
          uint assigned = unchecked((uint)Marshal.ReadInt32(buffer, 0));
          uint count = unchecked((uint)Marshal.ReadInt32(buffer, 4));
          if (assigned > count) {
            if (capacity >= 4096) throw new InvalidOperationException("Job member capture limit exceeded");
            capacity *= 2; continue;
          }
          if (count > capacity) throw new InvalidDataException("Job member list length invalid");
          for (int i = 0; i < count; i++) {
            ulong value = unchecked((ulong)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            if (value > UInt32.MaxValue) throw new InvalidDataException("Job process identifier invalid");
            ObservePid((uint)value, false);
          }
          return;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    }
    bool AllRetainedSignaled() {
      foreach (ProcessRecord record in observed.Values)
        if (!record.Retired && !Signaled(record.Handle)) return false;
      return true;
    }
    void BeginDrainBudget(int budgetMilliseconds) {
      Owner();
      if (drainClock == null) { drainClock = Stopwatch.StartNew(); drainBudget = budgetMilliseconds; }
      else drainBudget = Math.Min(drainBudget, budgetMilliseconds);
    }
    ACCOUNTING DrainProcesses() {
      StopForDrain();
      // Observation failure must never prevent the termination request itself.
      Check(job != IntPtr.Zero && TerminateJobObject(job, 125), "Terminate job");
      PumpNotifications(); CaptureMembers(); RetireSignaled();
      ACCOUNTING accounting;
      while (true) {
        PumpNotifications(); RetireSignaled();
        Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "Job accounting");
        if (accounting.ActiveProcesses == 0) {
          int covered = observed.Count + goneNotifications;
          if (covered > accounting.TotalProcesses) throw new InvalidOperationException("Job notification coverage exceeds lifetime accounting");
          if (covered == accounting.TotalProcesses && AllRetainedSignaled()) return accounting;
        }
        if (Remaining(drainClock, drainBudget) == 0) throw new TimeoutException("Job drain unconfirmed: lifetime process coverage or handle completion incomplete");
        Thread.Sleep(Math.Min(5, Remaining(drainClock, drainBudget)));
      }
    }
    void JoinRelays() {
      foreach (Thread thread in new[] { outputThread, errorThread, inputWriter })
        if (thread != null && !thread.Join(Remaining(drainClock, drainBudget))) throw new TimeoutException("Relay completion unconfirmed after job drain");
      if (drainClock.ElapsedMilliseconds > drainBudget) throw new TimeoutException("Job drain deadline exceeded");
    }
    public DrainResult WaitAndDrain(int budgetMilliseconds) {
      Owner(); if (!launched || drained) throw new InvalidOperationException("Invalid drain state");
      if (budgetMilliseconds < 1 || budgetMilliseconds > 5000) throw new ArgumentOutOfRangeException("budgetMilliseconds");
      while (process != IntPtr.Zero && !stopping && !Signaled(process)) {
        PumpNotifications(); CaptureMembers(); RetireSignaled(); stop.WaitOne(10);
      }
      BeginDrainBudget(budgetMilliseconds);
      uint code = 0;
      bool naturalExit = process != IntPtr.Zero && Signaled(process);
      if (naturalExit) Check(GetExitCodeProcess(process, out code), "Target exit code");
      ACCOUNTING accounting = DrainProcesses();
      if (process != IntPtr.Zero && !naturalExit) Check(GetExitCodeProcess(process, out code), "Terminated target exit code");
      // Output EOF is not custody proof. It is joined only after the job is drained.
      JoinRelays();
      if (relayFailure != null) throw new IOException("Relay failed; success proof refused: " + relayFailure);
      result = new DrainResult { TargetExitCode = code, TargetCreated = process != IntPtr.Zero,
        ActiveProcesses = accounting.ActiveProcesses, TotalProcesses = accounting.TotalProcesses,
        RetainedProcessHandles = observed.Count - retiredProcesses, RetiredProcesses = retiredProcesses,
        GoneProcessNotifications = goneNotifications, StopRequested = externalStopRequested,
        DrainMilliseconds = drainClock.ElapsedMilliseconds, RelayFailure = relayFailure };
      drained = true; return result;
    }
    public void WriteDrainedProof(string nonce, TextWriter destination, string prefix = "MIGANGO_JOB_DRAINED") {
      Owner(); Guid parsed;
      if (!Guid.TryParse(nonce, out parsed)) throw new ArgumentException("Nonce must be a UUID");
      if (prefix != "MIGANGO_JOB_DRAINED" && prefix != "MIGANGO_MCP_DRAINED" && prefix != "MIGANGO_SANDBOX_DRAINED")
        throw new ArgumentException("Invalid completion proof prefix");
      if (!drained || proofWritten) throw new InvalidOperationException("Drain proof unavailable");
      // Emit only after all child stderr pumping has stopped. Never emit on stdout MCP.
      // Separate a final unterminated target stderr line from the control frame.
      if (stderrLastByte >= 0 && stderrLastByte != 10) destination.WriteLine();
      destination.WriteLine(prefix + ":" + nonce);
      destination.Flush(); proofWritten = true;
    }
    public static string ReadUtf8Line(Stream source, int maxBytes) {
      // Never mix Console.ReadLine/StreamReader prefetch with this raw transport.
      using (var bytes = new MemoryStream()) {
        while (true) {
          int value = source.ReadByte();
          if (value < 0) return bytes.Length == 0 ? null : throwTruncated();
          if (value == 10) break;
          if (bytes.Length >= maxBytes) throw new InvalidDataException("Control frame limit exceeded");
          bytes.WriteByte((byte)value);
        }
        byte[] data = bytes.ToArray(); int count = data.Length;
        if (count > 0 && data[count - 1] == 13) count--;
        return new UTF8Encoding(false, true).GetString(data, 0, count);
      }
    }
    static string throwTruncated() { throw new InvalidDataException("Truncated control frame"); }
    public void Dispose() {
      if (disposed) return; Owner();
      RequestStop();
      if (job != IntPtr.Zero && !drained) {
        // Exception cleanup shares the original deadline and never grants proof.
        BeginDrainBudget(5000);
        try { DrainProcesses(); JoinRelays(); ExceptionalProcessDrainConfirmed = true; }
        catch (Exception failure) { ExceptionalDrainFailure = failure.GetType().Name + ": " + failure.Message; }
      }
      // On exceptional exit this requests kill-on-close, but does NOT create drain proof.
      Close(ref job);
      foreach (ProcessRecord record in observed.Values)
        if (record.Handle != process) { IntPtr handle = record.Handle; Close(ref handle); }
      observed.Clear(); heldByPid.Clear(); Close(ref process); Close(ref completionPort);
      // Never dispose a FileStream concurrently with a blocked synchronous pipe operation.
      // Production wrappers exit after this one-shot invocation; background host reads die with them.
      if (outputThread == null && output != null) output.Dispose();
      if (errorThread == null && error != null) error.Dispose();
      if (inputWriter == null && input != null) input.Dispose();
      disposed = true;
    }
  }
}
