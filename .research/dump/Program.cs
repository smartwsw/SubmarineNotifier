using System;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;

var dir = Environment.ExpandEnvironmentVariables(@"%APPDATA%\XIVLauncher\addon\Hooks\dev");
var loaded = new Dictionary<string, Assembly>();
Assembly Load(string simple)
{
    if (loaded.TryGetValue(simple, out var a)) return a;
    var asm = Assembly.LoadFrom(System.IO.Path.Combine(dir, simple + ".dll"));
    loaded[simple] = asm; return asm;
}
AppDomain.CurrentDomain.AssemblyResolve += (s, e) => { try { return Load(new AssemblyName(e.Name).Name); } catch { return null; } };
Type[] Types(Assembly a) { try { return a.GetTypes(); } catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t=>t!=null).ToArray()!; } }

var lt = Types(Load("Lumina"));
var ro = lt.First(t=>t.FullName=="Lumina.Text.ReadOnly.ReadOnlySeString");
Console.WriteLine("ReadOnlySeString members:");
foreach (var m in ro.GetMethods(BindingFlags.Public|BindingFlags.Instance|BindingFlags.Static).Where(m=>!m.IsSpecialName && (m.Name.Contains("String")||m.Name=="ToString"||m.Name.Contains("Encode")||m.Name.Contains("Ascii"))))
    Console.WriteLine($"  M {(m.IsStatic?"static ":"")}{m.ReturnType.Name} {m.Name}({string.Join(",", m.GetParameters().Select(p=>p.ParameterType.Name))})");
var ext = lt.FirstOrDefault(t=>t.Name=="SeStringExtensions" || t.Name.Contains("ReadOnlySeStringExtensions"));
Console.WriteLine("Ext=" + ext?.FullName);
if (ext!=null) foreach (var m in ext.GetMethods(BindingFlags.Public|BindingFlags.Static)) Console.WriteLine($"  EM {m.ReturnType.Name} {m.Name}");
