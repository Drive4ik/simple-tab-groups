# strip-res.ps1 — removes unused resources linked into the built exe by the RTL/VCL.
# Uses the WinAPI Begin/Update/EndUpdateResource calls, no third-party tools (Resource Hacker etc).
# Invoked by the StripResources post-build target in STGHost.dproj.
# Idempotent; its own errors never fail the build.

param([Parameter(Mandatory = $true)][string]$ExePath)

# ============================ WHAT TO REMOVE =========================
# Edit this list only. Each rule = a PE resource type + name pattern(s).
#   Type  — PE resource type number (table below)
#   Match — '*'         the whole type
#         | 'BB*'       wildcard name pattern (* and ?, case-insensitive)
#         | 'DVCLAL'    exact name
#         | 'A','B'     several names/patterns (for numeric ids write '#5')
# PE types: 1=Cursor 2=Bitmap 3=Icon 4=Menu 5=Dialog 6=String(string table)
#           9=Accelerator 10=RCData 11=MessageTable 12=GroupCursor 14=GroupIcon
#           16=Version 24=Manifest
#
# MUST STAY — these are live in this app, verified against the RAD Studio VCL sources:
#   2     SPINUP/SPINDOWN — TSpinButton loads them with LoadBitmap (Vcl.Samples.Spin.pas:403,430)
#         and MainForm has four TSpinEdit controls. Stripping type 2 blanks the spin arrows.
#   3/14  MAINICON — the app icon; About.pas also extracts it back out of the exe at runtime.
#   6     #4070..#4096 — RTL/VCL resourcestrings, i.e. exception texts. They reach logs.log and
#         the `message` field of protocol responses, so they earn their ~24 KB.
#   10    TMAINFORM/TABOUTFORM — the form DFMs.
#   16/24 version info and manifest — the whole point of STGHost.rc.
$StripRules = @(
    # VCL's own cursors. TScreen.CreateCursors (Vcl.Forms.pas:11155) does load them from the exe at
    # startup, but only for crSQLWait..crDrag — drag&drop and splitter cursors. This app has no
    # drag&drop, no splitters and no BDE, so nothing ever selects one; a missing cursor just makes
    # LoadCursor return 0.
    @{ Type = 1;  Match = '*' }
    @{ Type = 12; Match = '*' }

    # TBitBtn glyphs, ~67 KB — the single biggest win here. Loaded lazily by TBitBtn.SetKind
    # (Vcl.Buttons.pas:2716) and by TDBNavigator; this app has neither, only plain TButton.
    @{ Type = 10; Match = 'BB*' }

    # Icons of the VCL-drawn message dialog (Vcl.Dialogs.CreateMessageDialog, i.e. MessageDlg and
    # ShowMessage). This app goes straight to WinAPI MessageBox, and Vcl.Dialogs is linked only for
    # TFileOpenDialog.
    @{ Type = 10; Match = 'MSG_ERROR','MSG_INFO','MSG_WARNING' }

    @{ Type = 10; Match = 'DVCLAL'      }   # Delphi VCL license marker; nothing reads it at runtime
    @{ Type = 10; Match = 'PACKAGEINFO' }   # list of linked units/packages; only runtime packages need it

    # --- Match syntax examples (commented out) ---
    # @{ Type = 10; Match = 'DVCLAL','PACKAGEINFO' }  # LIST: just comma-separated. Matches any of the names
    # @{ Type = 6;  Match = '#5'  }  # NUMERIC id: '#'+number. Removes only the string block with id 5 (whole type is '*')
    # @{ Type = 10; Match = 'BB?' }  # ? = exactly ONE character: 'BB1'/'BBX' match, 'BBOK' (two chars) does not
    # @{ Type = 10; Match = 'BB*' }  # * = any number of characters (0+): 'BB', 'BBOK', 'BBCLOSE' all match
)
# =====================================================================

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public static class ResStrip
{
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr BeginUpdateResource(string f, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr data, uint cb);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr h, bool discard);

    delegate bool EnumNameProc(IntPtr mod, IntPtr type, IntPtr name, IntPtr param);
    delegate bool EnumLangProc(IntPtr mod, IntPtr type, IntPtr name, ushort lang, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool EnumResourceNames(IntPtr mod, IntPtr type, EnumNameProc cb, IntPtr param);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool EnumResourceLanguages(IntPtr mod, IntPtr type, IntPtr name, EnumLangProc cb, IntPtr param);

    struct Item { public IntPtr Type; public IntPtr Name; public bool NameAlloc; public ushort Lang; }
    public struct Rule { public int Type; public string[] Patterns; }

    static readonly List<Rule> _rules = new List<Rule>();
    static List<Item> _items;
    static Dictionary<long, int> _tally;
    static readonly EnumNameProc _onName = OnName;
    static readonly EnumLangProc _onLang = OnLang;

    public static string Summary = "";

    // rules come from PowerShell ($StripRules) via AddRule
    public static void ClearRules() { _rules.Clear(); }
    public static void AddRule(int type, string[] patterns) { _rules.Add(new Rule { Type = type, Patterns = patterns }); }

    static bool IsInt(IntPtr p) { return ((ulong)p.ToInt64() >> 16) == 0; }

    // display name of a resource: "#123" for a numeric id, otherwise the string name
    static string NameKey(IntPtr name) { return IsInt(name) ? ("#" + name.ToInt64()) : Marshal.PtrToStringUni(name); }

    // wildcard match (* and ?), case-insensitive
    static bool WildMatch(string pattern, string text)
    {
        if (text == null) return false;
        string rx = "^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$";
        return Regex.IsMatch(text, rx, RegexOptions.IgnoreCase);
    }

    static bool Wanted(IntPtr type, IntPtr name)
    {
        long t = type.ToInt64();
        string key = NameKey(name);
        foreach (Rule r in _rules)
        {
            if (r.Type != t) continue;
            foreach (string p in r.Patterns)
                if (WildMatch(p, key)) return true;
        }
        return false;
    }

    static bool OnName(IntPtr mod, IntPtr type, IntPtr name, IntPtr param)
    {
        if (Wanted(type, name))
            EnumResourceLanguages(mod, type, name, _onLang, IntPtr.Zero);
        return true;
    }

    static bool OnLang(IntPtr mod, IntPtr type, IntPtr name, ushort lang, IntPtr param)
    {
        Item it;
        it.Type = type;
        it.NameAlloc = !IsInt(name);
        // string names point into the mapped module's memory — copy them, the module gets unloaded
        it.Name = it.NameAlloc ? Marshal.StringToHGlobalUni(Marshal.PtrToStringUni(name)) : name;
        it.Lang = lang;
        _items.Add(it);
        return true;
    }

    public static int Run(string file)
    {
        _items = new List<Item>();
        _tally = new Dictionary<long, int>();
        IntPtr mod = LoadLibraryEx(file, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (mod == IntPtr.Zero) { Console.WriteLine("  [strip] LoadLibraryEx failed: " + Marshal.GetLastWin32Error()); return 0; }
        var types = new List<int>();
        foreach (Rule r in _rules) if (!types.Contains(r.Type)) types.Add(r.Type);
        try { foreach (int t in types) EnumResourceNames(mod, new IntPtr(t), _onName, IntPtr.Zero); }
        finally { FreeLibrary(mod); }

        if (_items.Count == 0) return 0;

        IntPtr h = BeginUpdateResource(file, false);
        if (h == IntPtr.Zero) { FreeNames(); throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error()); }
        int removed = 0;
        foreach (Item it in _items)
            if (UpdateResource(h, it.Type, it.Name, it.Lang, IntPtr.Zero, 0))
            {
                removed++;
                long t = it.Type.ToInt64();
                _tally[t] = (_tally.ContainsKey(t) ? _tally[t] : 0) + 1;
            }
        bool ok = EndUpdateResource(h, false);
        FreeNames();
        if (!ok) throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());

        var parts = new List<string>();
        foreach (var kv in _tally) parts.Add(TypeName(kv.Key) + "=" + kv.Value);
        Summary = string.Join(", ", parts.ToArray());
        return removed;
    }

    static string TypeName(long t)
    {
        switch (t)
        {
            case 1: return "Cursor";
            case 2: return "Bitmap";
            case 3: return "Icon";
            case 4: return "Menu";
            case 5: return "Dialog";
            case 6: return "String";
            case 9: return "Accelerator";
            case 10: return "RCData";
            case 11: return "MessageTable";
            case 12: return "GroupCursor";
            case 14: return "GroupIcon";
            case 16: return "Version";
            case 24: return "Manifest";
            default: return "Type#" + t;
        }
    }

    static void FreeNames()
    {
        foreach (Item it in _items) if (it.NameAlloc) Marshal.FreeHGlobal(it.Name);
    }
}
'@

try {
    if (-not (Test-Path -LiteralPath $ExePath)) { Write-Host "  [strip] file not found: $ExePath"; exit 0 }
    $full = (Resolve-Path -LiteralPath $ExePath).Path
    $before = (Get-Item -LiteralPath $full).Length
    Add-Type -TypeDefinition $cs -Language CSharp
    [ResStrip]::ClearRules()
    foreach ($r in $StripRules) { [ResStrip]::AddRule([int]$r.Type, [string[]]@($r.Match)) }
    $removed = [ResStrip]::Run($full)
    $after = (Get-Item -LiteralPath $full).Length
    Write-Host ("  [strip] {0}: removed {1} resources [{2}], {3} -> {4} bytes (-{5})" -f (Split-Path $full -Leaf), $removed, [ResStrip]::Summary, $before, $after, ($before - $after))
}
catch {
    Write-Host "  [strip] warning (skipped): $($_.Exception.Message)"
}
exit 0
