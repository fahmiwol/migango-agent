namespace MiganNativeEntry {
using System;
using System.Collections.Generic;
using System.Reflection;
public static class MiganNativeMain {
 [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,System.Text.StringBuilder image,ref int size);
 public static int Main(string[] args) {
  try {
   // Explicit pipe writers work without a console (detached supervisors).
   // Encoding setters call SetConsoleCP and fail with ERROR_INVALID_HANDLE there.
   var utf8=new System.Text.UTF8Encoding(false);
   Console.SetOut(new System.IO.StreamWriter(Console.OpenStandardOutput(),utf8){AutoFlush=true});
   Console.SetError(new System.IO.StreamWriter(Console.OpenStandardError(),utf8){AutoFlush=true});
   if(args.Length==1&&args[0]=="--local-image-path"){
    int size=32768;var image=new System.Text.StringBuilder(size);
    if(!QueryFullProcessImageName(new IntPtr(-1),0,image,ref size))throw new Exception("Native image query failed");
    Console.Out.Write(image.ToString());return 0;
   }
   string name=Assembly.GetExecutingAssembly().GetName().Name;
   string type=name=="appcontainer"?"MiganContainer":name=="windows-job"?"MiganJob":name=="mcp-job"?"MiganMcpJob":name=="process-identity"?"MiganIdentity":null;
   if(type==null)throw new Exception("Unknown native worker");
   Type worker=Assembly.GetExecutingAssembly().GetType(type,true);
   if(name=="appcontainer"&&args.Length==2&&args[0]=="-CleanupRoot"){
    Console.Out.Write(worker.GetMethod("Recover").Invoke(null,new object[]{args[1]}));return 0;
   }
   if(name=="process-identity"){
    var values=new Dictionary<string,string>();
    if(args.Length%2!=0)throw new Exception("Invalid identity request");
    for(int i=0;i<args.Length;i+=2)values.Add(args[i],args[i+1]);
    string mode=values["-Mode"];int pid=int.Parse(values["-TargetId"]);
    string started=values.ContainsKey("-ExpectedStarted")?values["-ExpectedStarted"]:null;
    string executable=values.ContainsKey("-ExpectedExecutable")?values["-ExpectedExecutable"]:null;
    if(mode!="Inspect"&&mode!="Terminate")throw new Exception("Invalid identity mode");
    Console.Out.Write(worker.GetMethod("Run").Invoke(null,new object[]{mode,pid,started,executable}));return 0;
   }
   object result=worker.GetMethod("Run").Invoke(null,null);
   return result is int?(int)result:0;
  }catch(Exception error){
   while(error is TargetInvocationException&&error.InnerException!=null)error=error.InnerException;
   Console.Error.WriteLine("Native worker failed: "+error.GetType().Name+" hr="+error.HResult+"; inspect external effects");
   Console.Error.WriteLine(error.StackTrace);
   return 125;
  }
 }
}
}
