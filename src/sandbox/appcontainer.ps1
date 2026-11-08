param([string]$CleanupRoot='')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$nativeSource = @'
using System;using System.IO;using System.Text;using System.Threading;using System.Diagnostics;using System.Collections;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Security.AccessControl;using System.Security.Principal;using Microsoft.Win32.SafeHandles;using System.Web.Script.Serialization;
public static class MiganContainer {
 [StructLayout(LayoutKind.Sequential)]struct SA{public int size;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct SI{public int cb;public string reserved,desktop,title;public uint x,y,xs,ys,xc,yc,fill,flags;public ushort show,rs;public IntPtr r2,input,output,error;}
 [StructLayout(LayoutKind.Sequential)]struct SIX{public SI si;public IntPtr attrs;}
 [StructLayout(LayoutKind.Sequential)]struct PI{public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)]struct CAPS{public IntPtr sid,caps;public uint count,reserved;}
 [StructLayout(LayoutKind.Sequential)]struct BASIC{public long pt,jt;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)]struct IO{public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)]struct EXT{public BASIC basic;public IO io;public UIntPtr pm,jm,pp,pj;}
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int DeleteAppContainerProfile(string name);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
 [DllImport("advapi32.dll")]static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern IntPtr CreateFile(string file,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT info,int size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int type,IntPtr buffer,int size,out int needed);
 static void Check(bool ok,string op){if(!ok)throw new Exception(op+" failed: "+Marshal.GetLastWin32Error());}
 static string Quote(string s){var b=new StringBuilder("\"");int n=0;foreach(char c in s){if(c=='\\'){n++;continue;}if(c=='"'){b.Append('\\',n*2+1);b.Append('"');n=0;continue;}b.Append('\\',n);n=0;b.Append(c);}b.Append('\\',n*2);return b.Append('"').ToString();}
 static void Access(string target,SecurityIdentifier sid,bool add){using(var mutex=new Mutex(false,"Local\\miganGO-sandbox-acl-v1")){try{mutex.WaitOne();}catch(AbandonedMutexException){}try{if(Directory.Exists(target)){var a=Directory.GetAccessControl(target);var r=new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow);if(add)a.AddAccessRule(r);else a.RemoveAccessRuleSpecific(r);Directory.SetAccessControl(target,a);}else{var a=File.GetAccessControl(target);var r=new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,AccessControlType.Allow);if(add)a.AddAccessRule(r);else a.RemoveAccessRuleSpecific(r);File.SetAccessControl(target,a);}}finally{mutex.ReleaseMutex();}}}
 static void Pump(IntPtr handle,Stream output){using(var f=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read)){byte[] b=new byte[4096];int n;while((n=f.Read(b,0,b.Length))>0){output.Write(b,0,n);output.Flush();}}}
 static int TokenInt(IntPtr token,int type){IntPtr v=Marshal.AllocHGlobal(4096);try{int needed;Check(GetTokenInformation(token,type,v,4096,out needed),"Token attestation");return Marshal.ReadInt32(v);}finally{Marshal.FreeHGlobal(v);}}
 static void WriteLease(string filename,Dictionary<string,object> value){
  string profile=Path.GetFileNameWithoutExtension(filename);
  using(var mutex=new Mutex(false,"Local\\miganGO-recover-"+profile)){
   bool owned=false;
   try{
    try{owned=mutex.WaitOne(5000);}catch(AbandonedMutexException){owned=true;}
    if(!owned)throw new IOException("Sandbox lease publication busy");
    byte[] bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));string tmp=filename+".tmp";
    using(var stream=new FileStream(tmp,FileMode.Create,FileAccess.Write,FileShare.None)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
    if(File.Exists(filename))File.Replace(tmp,filename,null);else File.Move(tmp,filename);
   }finally{if(owned)mutex.ReleaseMutex();}
  }
 }
 static bool Reparse(string target){for(string p=Path.GetFullPath(target);p!=null;p=Path.GetDirectoryName(p)){if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)return true;}return false;}
 static Dictionary<string,object> ReadLease(string file){
  try{using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete))using(var reader=new StreamReader(stream)){var r=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());if(r==null)throw new Exception("Invalid null sandbox lease");return r;}}
  catch(FileNotFoundException){return null;}catch(DirectoryNotFoundException){return null;}
 }
 static bool SupervisorAlive(Dictionary<string,object> record){
  IntPtr handle=OpenProcess(0x1000|0x100000,false,Convert.ToInt32(record["pid"]));
  if(handle==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==87)return false;throw new System.ComponentModel.Win32Exception(error);}
  try{
   uint state=WaitForSingleObject(handle,0);if(state==0)return false;if(state!=0x102)throw new Exception("Cannot verify supervisor liveness");
   long created,exited,kernel,user;Check(GetProcessTimes(handle,out created,out exited,out kernel,out user),"Supervisor identity");
   return DateTime.FromFileTimeUtc(created).Ticks.ToString()==(string)record["started"];
  }finally{CloseHandle(handle);}
 }
 public static int Recover(string root){
  int cleaned=0;string[] files;try{files=Directory.GetFiles(root,"miganGO-sandbox-*.json");}catch(DirectoryNotFoundException){return 0;}
  foreach(string file in files){
   string profile=Path.GetFileNameWithoutExtension(file);if(!System.Text.RegularExpressions.Regex.IsMatch(profile,"^miganGO-sandbox-[a-f0-9]{32}$"))throw new Exception("Invalid sandbox lease name");
   // Only cleanup for the same lease is coalesced; different candidates remain parallel.
   using(var mutex=new Mutex(false,"Local\\miganGO-recover-"+profile)){
    bool owned=false;try{try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}if(!owned)continue;
     var r=ReadLease(file);if(r==null)continue;if((string)r["profile"]!=profile)throw new Exception("Invalid sandbox lease identity");
     if(SupervisorAlive(r))continue;
     var identity=new SecurityIdentifier((string)r["sid"]);IntPtr expected;int derived=DeriveAppContainerSidFromAppContainerName(profile,out expected);if(derived<0)throw new Exception("Cannot verify lease SID");try{if(identity.Value!=new SecurityIdentifier(expected).Value)throw new Exception("Lease SID mismatch");}finally{FreeSid(expected);}
     foreach(object item in (ArrayList)r["grants"]){string target=(string)item;try{if(Reparse(target))throw new Exception("Sandbox lease reparse blocked");Access(target,identity,false);}catch(FileNotFoundException){}catch(DirectoryNotFoundException){}}
     int hr=DeleteAppContainerProfile(profile);if(hr<0&&hr!=unchecked((int)0x80070002)&&hr!=unchecked((int)0x80070003)&&hr!=unchecked((int)0x80070490))throw new Exception("Sandbox profile cleanup failed: "+hr);
     File.Delete(file);cleaned++;
    }finally{if(owned)mutex.ReleaseMutex();}
   }
  }return cleaned;
 }
 public static int Run(){
  Stream hostInput=Console.OpenStandardInput();
  string first=Migan.Native.NativeJobTree.ReadUtf8Line(hostInput,1024*1024);
  if(first==null)throw new IOException("Sandbox request unavailable");
  var r=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(first);
  string profile=(string)r["profile"],dir=(string)r["execution"],exe=(string)r["executable"],nonce=(string)r["nonce"];
  if(!System.Text.RegularExpressions.Regex.IsMatch(profile,"^miganGO-sandbox-[a-f0-9]{32}$"))throw new Exception("Invalid owned profile");
  Guid parsedNonce;if(!Guid.TryParse(nonce,out parsedNonce))throw new Exception("Invalid sandbox nonce");
  IntPtr sid=IntPtr.Zero,cp=IntPtr.Zero;
  int hr=DeriveAppContainerSidFromAppContainerName(profile,out sid);
  if(hr<0)throw new Exception("AppContainer SID unavailable: "+hr);
  var identity=new SecurityIdentifier(sid);
  var grants=new List<string>();
  string leaseRoot=(string)r["leaseRoot"],lease=Path.Combine(leaseRoot,profile+".json");
  var leaseRecord=new Dictionary<string,object>{{"profile",profile},{"sid",identity.Value},{"pid",Process.GetCurrentProcess().Id},{"started",Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()},{"grants",new[]{dir,exe}}};
  try{
   using(var tree=new Migan.Native.NativeJobTree()){
    // This reader never shares the target stdin and cannot be blocked by a child write.
    tree.StartEofMonitor(hostInput);
    Directory.CreateDirectory(leaseRoot);WriteLease(lease,leaseRecord);
    IntPtr created;hr=CreateAppContainerProfile(profile,profile,"miganGO zero-network candidate",IntPtr.Zero,0,out created);
    if(hr<0)throw new Exception("AppContainer unavailable: "+hr);
    FreeSid(sid);sid=created;
    if(new SecurityIdentifier(sid).Value!=identity.Value)throw new Exception("AppContainer profile SID mismatch");
    Access(dir,identity,true);grants.Add(dir);Access(exe,identity,true);grants.Add(exe);
    CAPS caps=new CAPS();caps.sid=sid;
    cp=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS)));Marshal.StructureToPtr(caps,cp,false);
    var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach(var pair in (Dictionary<string,object>)r["environment"])values[pair.Key]=(string)pair.Value;
    var arguments=new List<string>();foreach(object arg in (ArrayList)r["args"])arguments.Add((string)arg);
    tree.Launch(new Migan.Native.NativeJobTree.LaunchOptions{
     Executable=exe,WorkingDirectory=dir,Arguments=arguments.ToArray(),Environment=values,PipeInput=false,
     ProcessLimit=8,JobMemoryBytes=768UL*1024UL*1024UL,
     ExtraAttributes=new[]{new Migan.Native.NativeJobTree.AttributeValue(new IntPtr(0x20009),cp,new IntPtr(Marshal.SizeOf(typeof(CAPS))))},
     AttestSuspended=delegate(IntPtr target){
      IntPtr token=IntPtr.Zero;int container,count;
      try{Check(OpenProcessToken(target,8,out token),"Process token");container=TokenInt(token,29);count=TokenInt(token,30);}
      finally{if(token!=IntPtr.Zero)CloseHandle(token);}
      Check(container==1&&count==0,"Zero capability boundary");
      // Durable candidate identity and zero-capability attestation precede ResumeThread.
      leaseRecord["candidatePid"]=tree.ProcessId;WriteLease(lease,leaseRecord);
      var meta=new Dictionary<string,object>{{"kind","windows-appcontainer"},{"network","deny"},{"isAppContainer",true},{"capabilities",count},{"lpac",false},{"memoryMiB",768},{"processLimit",8},{"profile",profile},{"sid",identity.Value}};
      Console.Error.WriteLine("MIGANGO_SANDBOX_READY:"+nonce+":"+Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(meta))));Console.Error.Flush();
     }
    });
    tree.StartOutputPumps(Console.OpenStandardOutput(),Console.OpenStandardError());
    var result=tree.WaitAndDrain(5000);
    if(result.StopRequested){
     // Host EOF may be a crash. Retain the committed profile/ACL lease for
     // recovery; the completion frame attests process drain, not task success.
     tree.WriteDrainedProof(nonce,Console.Error,"MIGANGO_SANDBOX_DRAINED");
     return unchecked((int)result.TargetExitCode);
    }
    // Cleanup is attempted only after confirmed drain. On any earlier exception the
    // durable lease is retained for existing Recover(), never deleted optimistically.
    var cleanupClock=Stopwatch.StartNew();
    Action requireCleanupBudget=delegate(){if(result.DrainMilliseconds+cleanupClock.ElapsedMilliseconds>=5000)throw new TimeoutException("Sandbox cleanup deadline exceeded; proof withheld");};
    bool clean=true;
    foreach(string target in grants){
     requireCleanupBudget();
     try{Access(target,identity,false);}catch{clean=false;}
    }
    requireCleanupBudget();
    if(DeleteAppContainerProfile(profile)<0)clean=false;
    requireCleanupBudget();
    if(!clean)throw new IOException("Sandbox cleanup incomplete; lease retained and proof withheld");
    File.Delete(lease);requireCleanupBudget();
    tree.WriteDrainedProof(nonce,Console.Error,"MIGANGO_SANDBOX_DRAINED");
    return unchecked((int)result.TargetExitCode);
   }
  }finally{
   if(cp!=IntPtr.Zero)Marshal.FreeHGlobal(cp);
   if(sid!=IntPtr.Zero)FreeSid(sid);
  }
 }
}
'@
. (Join-Path $PSScriptRoot '../recovery/native-loader.ps1')
Import-MiganNative -Root $PSScriptRoot -Name 'appcontainer' -Source $nativeSource
try { if($CleanupRoot){[Console]::Out.Write([MiganContainer]::Recover($CleanupRoot));exit 0};exit ([MiganContainer]::Run()) } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 125 }
