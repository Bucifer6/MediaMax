// Vibe tray app for Windows: runs the server in the background and puts an icon in the notification area,
// like other Windows media servers. Installed next to kinora.exe by the setup program (vibe.iss).
//
// Built on the Windows release runner with the C# compiler that ships with the .NET Framework
// (scripts/build-installer.mjs), so it must stay C# 5: no string interpolation, no ?. operator.
//
//   VibeTray.exe                  start (or attach to) the server and show the tray icon
//   VibeTray.exe --open           ... and open Vibe in the browser once it answers
//   VibeTray.exe --autostart on   start at sign-in (HKCU Run) on/off, then exit (used by the installer)
//   VibeTray.exe --quit           stop a running tray app (and the server it started), then exit
//
// When Vibe is installed as a background service (the "Kinora" scheduled task, running as SYSTEM), the tray
// app never starts a second server: it only shows the status and opens the web app.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Vibe")]
[assembly: AssemblyProduct("Vibe")]
[assembly: AssemblyDescription("Vibe media server tray app")]

namespace Vibe.Tray
{
    static class Program
    {
        internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        internal const string RunValue = "Vibe";
        internal const string QuitEventName = @"Local\VibeTray.Quit";

        [STAThread]
        static int Main(string[] args)
        {
            bool open = false;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i].ToLowerInvariant();
                if (a == "--autostart" && i + 1 < args.Length)
                {
                    SetAutostart(args[i + 1].ToLowerInvariant() == "on");
                    return 0;
                }
                if (a == "--quit")
                {
                    EventWaitHandle ev;
                    if (EventWaitHandle.TryOpenExisting(QuitEventName, out ev)) { ev.Set(); ev.Dispose(); }
                    return 0;
                }
                if (a == "--open") open = true;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, @"Local\VibeTray.Running", out created))
            {
                if (!created)
                {
                    // Already running for this user: just open the web app.
                    TrayContext.OpenBrowser(Settings.Url);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext(open));
            }
            return 0;
        }

        internal static bool AutostartEnabled()
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                return k != null && k.GetValue(RunValue) != null;
            }
        }

        internal static void SetAutostart(bool on)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
                else if (k.GetValue(RunValue) != null) k.DeleteValue(RunValue);
            }
        }
    }

    /// <summary>Same rules as the server (server/src/config.ts, server/src/env.ts).</summary>
    static class Settings
    {
        internal static string Env(string name)
        {
            string v = Environment.GetEnvironmentVariable("KINORA_" + name);
            if (String.IsNullOrEmpty(v)) v = Environment.GetEnvironmentVariable("MEDIAMAX_" + name);
            // The installer stores the port machine-wide; a tray started before that change still sees it.
            if (String.IsNullOrEmpty(v)) v = Environment.GetEnvironmentVariable("KINORA_" + name, EnvironmentVariableTarget.Machine);
            return String.IsNullOrEmpty(v) ? null : v;
        }

        internal static int Port
        {
            get
            {
                int p;
                return Int32.TryParse(Env("PORT"), out p) && p > 0 && p < 65536 ? p : 8484;
            }
        }

        internal static string Url { get { return "http://localhost:" + Port + "/"; } }

        internal static string DataDir
        {
            get
            {
                string d = Env("DATA");
                if (d != null) return d;
                string pd = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                string fresh = Path.Combine(pd, "Kinora"), legacy = Path.Combine(pd, "MediaMax");
                return !Directory.Exists(fresh) && Directory.Exists(legacy) ? legacy : fresh;
            }
        }

        internal static string AppDir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly NotifyIcon icon;
        readonly ToolStripMenuItem statusItem, restartItem, autostartItem;
        readonly System.Windows.Forms.Timer timer;
        readonly SynchronizationContext ui;
        readonly EventWaitHandle quitEvent;
        Process server;          // the kinora.exe this tray app started, if any
        bool stopping;
        bool openWhenReady;
        bool lastUp;
        bool announced;
        int quickExits;
        DateTime startedAt;
        readonly object consoleLock = new object();

        public TrayContext(bool open)
        {
            openWhenReady = open;
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            ui = SynchronizationContext.Current;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem openItem = new ToolStripMenuItem("Open Vibe", null, delegate { OpenBrowser(Settings.Url); });
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
            restartItem = new ToolStripMenuItem("Restart server", null, delegate { RestartServer(); });
            autostartItem = new ToolStripMenuItem("Start Vibe when I sign in", null, delegate
            {
                Program.SetAutostart(!autostartItem.Checked);
                autostartItem.Checked = Program.AutostartEnabled();
            });
            menu.Items.Add(openItem);
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripMenuItem("Open data folder", null, delegate { OpenFolder(Settings.DataDir); }));
            menu.Items.Add(new ToolStripMenuItem("Open logs", null, delegate { OpenFolder(Path.Combine(Settings.DataDir, "logs")); }));
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Quit(); }));
            menu.Opening += delegate
            {
                autostartItem.Checked = Program.AutostartEnabled();
                restartItem.Visible = !ServiceInstalled();
            };

            icon = new NotifyIcon();
            icon.Text = "Vibe";
            try { icon.Icon = new Icon(Icon.ExtractAssociatedIcon(Application.ExecutablePath), SystemInformation.SmallIconSize); } catch { icon.Icon = SystemIcons.Application; }
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenBrowser(Settings.Url); };
            icon.Visible = true;

            // "VibeTray.exe --quit" (used by the installer and uninstaller) asks this instance to stop cleanly.
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { ui.Post(delegate { Quit(); }, null); }, null, -1, true);

            EnsureServer();
            timer = new System.Windows.Forms.Timer();
            timer.Interval = 3000;
            timer.Tick += delegate { Poll(); };
            timer.Start();
            Poll();
        }

        static bool ServiceInstalled()
        {
            // Set by the installer when it registers the boot-time "Kinora" task (service mode). A task registered
            // by hand with install-service.ps1 is not seen here, but then the server answers and is left alone.
            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Kinora"))
                {
                    return k != null && Convert.ToInt32(k.GetValue("ServiceMode", 0)) == 1;
                }
            }
            catch { return false; }
        }

        static bool Healthy()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Settings.Port + "/health");
                req.Timeout = 2000;
                req.Proxy = null;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return (int)res.StatusCode < 500;
                }
            }
            catch (WebException e)
            {
                // Any HTTP answer means the server is up.
                return e.Response != null;
            }
            catch { return false; }
        }

        void EnsureServer()
        {
            if (stopping || (server != null && !server.HasExited)) return;
            if (ServiceInstalled() || Healthy()) return; // someone else runs it
            string exe = Path.Combine(Settings.AppDir, "kinora.exe");
            if (!File.Exists(exe))
            {
                icon.ShowBalloonTip(10000, "Vibe", "kinora.exe was not found next to VibeTray.exe. Reinstall Vibe.", ToolTipIcon.Error);
                return;
            }
            ProcessStartInfo psi = new ProcessStartInfo(exe);
            psi.WorkingDirectory = Settings.AppDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            // The server's error output: the only place a fatal crash (out of memory, a native fault) is written,
            // since the process dies before its own log is flushed. Kept in logs\server-console.log with each exit code.
            psi.RedirectStandardError = true;
            // Pass on the machine-wide settings the installer wrote, which a tray started from an older
            // environment block (e.g. right after setup) would not have inherited.
            psi.EnvironmentVariables["KINORA_PORT"] = Settings.Port.ToString();
            string data = Settings.Env("DATA");
            if (data != null) psi.EnvironmentVariables["KINORA_DATA"] = data;
            try
            {
                Process p = Process.Start(psi);
                server = p;
                p.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs ev) { if (ev.Data != null) ConsoleLog(ev.Data); };
                p.BeginErrorReadLine();
                p.EnableRaisingEvents = true;
                p.Exited += delegate
                {
                    // WaitForExit() also waits for the redirected output to be read to the end.
                    try { p.WaitForExit(); } catch { }
                    int code = -1;
                    try { code = p.ExitCode; } catch { }
                    ConsoleLog("[tray] Server exited with code " + code + " (0x" + code.ToString("X8") + ") after " + Math.Round((DateTime.UtcNow - startedAt).TotalSeconds) + " s");
                    ui.Post(delegate { OnServerExited(); }, null);
                };
                startedAt = DateTime.UtcNow;
                ConsoleLog("[tray] Server started (process " + p.Id + ")");
            }
            catch (Exception e)
            {
                server = null;
                icon.ShowBalloonTip(10000, "Vibe could not start", e.Message, ToolTipIcon.Error);
            }
        }

        /// <summary>Appends a timestamped line to logs\server-console.log (rotated at 5 MB). Never throws.</summary>
        void ConsoleLog(string line)
        {
            lock (consoleLock)
            {
                try
                {
                    string dir = Path.Combine(Settings.DataDir, "logs");
                    Directory.CreateDirectory(dir);
                    string file = Path.Combine(dir, "server-console.log");
                    FileInfo fi = new FileInfo(file);
                    if (fi.Exists && fi.Length > 5 * 1024 * 1024)
                    {
                        File.Copy(file, file + ".1", true);
                        File.Delete(file);
                    }
                    File.AppendAllText(file, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + line + Environment.NewLine);
                }
                catch { }
            }
        }

        void OnServerExited()
        {
            if (stopping) return;
            // Admin > Restart (and updates) end the process on purpose: start it again. Give up on a crash loop.
            quickExits = (DateTime.UtcNow - startedAt).TotalSeconds < 30 ? quickExits + 1 : 0;
            server = null;
            if (quickExits >= 5)
            {
                icon.ShowBalloonTip(15000, "Vibe stopped", "The server keeps exiting. See the logs (right-click the Vibe icon > Open logs).", ToolTipIcon.Error);
                return;
            }
            EnsureServer();
        }

        void Poll()
        {
            bool up = Healthy();
            if (!up && server == null && quickExits < 5) EnsureServer();
            string status = up ? "Running on port " + Settings.Port : (server != null ? "Starting..." : "Not running");
            if (ServiceInstalled()) status += " (service)";
            statusItem.Text = status;
            string tip = "Vibe - " + status;
            icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            if (up && openWhenReady)
            {
                openWhenReady = false;
                OpenBrowser(Settings.Url);
            }
            if (up && !lastUp && !announced)
            {
                announced = true;
                icon.ShowBalloonTip(5000, "Vibe is running", "Double-click the Vibe icon to open it. Right-click for more.", ToolTipIcon.Info);
            }
            lastUp = up;
        }

        void StopServer()
        {
            Process p = server;
            server = null;
            if (p == null) return;
            try
            {
                if (!p.HasExited) { p.Kill(); p.WaitForExit(10000); }
            }
            catch { }
            p.Dispose();
        }

        void RestartServer()
        {
            stopping = true;
            StopServer();
            stopping = false;
            quickExits = 0;
            lastUp = false;
            EnsureServer();
        }

        void Quit()
        {
            if (stopping) return;
            stopping = true;
            timer.Stop();
            StopServer();
            icon.Visible = false;
            icon.Dispose();
            ExitThread();
        }

        internal static void OpenBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        static void OpenFolder(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) dir = Settings.DataDir;
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch { }
        }
    }
}
