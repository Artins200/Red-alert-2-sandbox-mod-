/* ===========================================================================
   RED ALERT 2 SANDBOX MOD -- engine
   ---------------------------------------------------------------------------
   Runs on Windows Script Host (cscript.exe), JScript / ES3 dialect.
   No installs, no dependencies.

   What it does:
     1. Takes the untouched vanilla rules files from .\rules\
     2. Applies the sandbox patch set according to .\config\sandbox.cfg
     3. Drops the patched rules.ini / rulesmd.ini into the game folder
        (backing up whatever was there)
     4. Writes comfortable skirmish defaults into RA2.INI / RA2MD.INI
     5. Launches the game and waits for it to exit
     6. Restores the game folder to its original state

   Usage (normally called by SandboxMod.bat):
     cscript //nologo sandbox.js            -> interactive menu
     SANDBOX_CMD="<gamemd.exe> -args"       -> patch, run, restore (Steam mode)
     cscript //nologo sandbox.js prepare
     cscript //nologo sandbox.js restore
     cscript //nologo sandbox.js diag
     cscript //nologo sandbox.js uninstall
   =========================================================================== */

var fso = new ActiveXObject("Scripting.FileSystemObject");
var sh  = new ActiveXObject("WScript.Shell");

var SCRIPT_FILE = WScript.ScriptFullName;
var TOOLS_DIR   = fso.GetParentFolderName(SCRIPT_FILE);
var MOD_DIR     = fso.GetParentFolderName(TOOLS_DIR);
var CFG_DIR     = join(MOD_DIR, "config");
var CFG_PATH    = join(CFG_DIR, "sandbox.cfg");
var RULES_DIR   = join(MOD_DIR, "rules");
var BACKUP_DIR  = join(MOD_DIR, "backup");
var STATE_DIR   = join(MOD_DIR, "state");
var STATE_PATH  = join(STATE_DIR, "session.txt");
var MARKER      = "; ==== RA2 SANDBOX MOD (generated file, do not edit) ====";

/* ------------------------------------------------------------------ helpers */

function join(a, b) { return fso.BuildPath(a, b); }

function exists(path) { return fso.FileExists(path); }
function dirExists(path) { return fso.FolderExists(path); }

function ensureDir(path) {
  if (dirExists(path)) { return; }
  var parent = fso.GetParentFolderName(path);
  if (parent && !dirExists(parent)) { ensureDir(parent); }
  fso.CreateFolder(path);
}

function readLines(path) {
  var out = [];
  var ts = fso.OpenTextFile(path, 1, false, -2); /* ForReading, default encoding */
  while (!ts.AtEndOfStream) { out.push(ts.ReadLine()); }
  ts.Close();
  return out;
}

function readText(path) {
  var lines = readLines(path);
  return lines.join("\r\n");
}

function writeLines(path, lines) {
  var ts = fso.CreateTextFile(path, true, false); /* overwrite, ascii/ansi */
  for (var i = 0; i < lines.length; i++) { ts.WriteLine(lines[i]); }
  ts.Close();
}

function copyFile(src, dst) {
  ensureDir(fso.GetParentFolderName(dst));
  fso.CopyFile(src, dst, true);
}

function deleteFile(path) {
  if (exists(path)) { try { fso.DeleteFile(path, true); } catch (e) {} }
}

function trim(s) {
  if (s === null || s === undefined) { return ""; }
  return String(s).replace(/^\s+/, "").replace(/\s+$/, "");
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) { s = s + " "; }
  return s;
}

function intVal(s, dflt) {
  var n = parseInt(s, 10);
  return isNaN(n) ? dflt : n;
}

function lower(s) { return String(s).toLowerCase(); }

/* --------------------------------------------------------------------- log */
/* Every run is written to logs\session-*.log: if the game dies with an internal
   error, that file shows what was patched, what exactly was launched and when
   the files were restored. */

var LOG_PATH = "";

function logStamp() {
  var d = new Date();
  function two(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" +
         two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}

function startLog() {
  try {
    var dir = join(MOD_DIR, "logs");
    ensureDir(dir);
    LOG_PATH = join(dir, "session-" + logStamp() + ".log");
    writeLines(LOG_PATH, ["Red Alert 2 Sandbox Mod - session log",
                          "started: " + new Date().toString(), ""]);
    writeLines(join(dir, "last.txt"), [LOG_PATH]);
  } catch (e) {
    LOG_PATH = "";
  }
}

function appendLog(line) {
  if (LOG_PATH === "") { return; }
  try {
    var ts = fso.OpenTextFile(LOG_PATH, 8, true); /* ForAppending, create */
    ts.WriteLine(line);
    ts.Close();
  } catch (e) { }
}

/* --------------------------------------------------------------- ini engine */

/* Returns [headerIndex, endIndex) of a section, or null. */
function iniFindSection(lines, name) {
  var want = lower(name);
  for (var i = 0; i < lines.length; i++) {
    var m = /^\s*\[([^\]]+)\]/.exec(lines[i]);
    if (m && lower(trim(m[1])) === want) {
      var j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) { j++; }
      return [i, j];
    }
  }
  return null;
}

function iniGet(lines, section, key) {
  var r = iniFindSection(lines, section);
  if (r === null) { return null; }
  var re = new RegExp("^\\s*" + key + "\\s*=\\s*(.*)$", "i");
  for (var i = r[0] + 1; i < r[1]; i++) {
    var m = re.exec(lines[i]);
    if (m) { return trim(m[1]); }
  }
  return null;
}

/* Replace key inside section; if missing, insert right after the header
   (unless onlyIfExists). Returns true on success. */
function iniSet(lines, section, key, value, onlyIfExists) {
  var r = iniFindSection(lines, section);
  if (r === null) { return false; }
  var re = new RegExp("^\\s*" + key + "\\s*=", "i");
  for (var i = r[0] + 1; i < r[1]; i++) {
    if (re.test(lines[i])) { lines[i] = key + "=" + value; return true; }
  }
  if (onlyIfExists) { return false; }
  lines.splice(r[0] + 1, 0, key + "=" + value);
  return true;
}

/* -------------------------------------------------------------- definitions */

var DEFAULTS = {
  Target:          "both",      /* both | yr | ra2 */
  SandboxSW:       "player",    /* player | all | off */
  SWRecharge:      "instant",   /* instant | fast | normal */
  Heroes:          "normal",    /* unlimited | normal */
  BonusBuildings:  "normal",    /* unlimited | normal */
  RevealMap:       "yes",       /* yes | no */
  BigBoom:         "yes",       /* yes | no */
  BuildSpeed:      "normal",    /* instant | fast | normal (affects the AI too) */
  SellRefund:      "100",       /* 100 | 50 */
  FairAI:          "yes",       /* yes | no */
  Money:           "40000",
  UnitCount:       "10",
  TechLevel:       "10",
  GameSpeed:       "1",
  Crates:          "yes",
  ShortGame:       "no",
  FogOfWar:        "no",
  AIPlayers:       "2",
  AIDifficulty:    "1",         /* 0 = Easy, 1 = Normal, 2 = Brutal */
  CarpetNuke:      "6",         /* LineMultiplier of the nuke superweapon (BigBoom) */
  Patches:         "full",      /* full | safe | none - how much to patch (for bug hunting) */
  KitCost:         "1500",      /* cost of the sandbox superweapon buildings */
  GameDir:         "",          /* optional override */
  CfgVer:          "0"          /* settings file format (used for migration) */
};

var GAMES = {
  yr: {
    key: "yr",
    label: "Yuri's Revenge",
    rulesFile: "rulesmd.ini",
    source: "rulesmd.ini",
    swBuildings: ["GACSPH", "GAWEAT", "NAIRON", "NAMISL", "YAGNTC", "YAPPET"],
    swSpecials: ["ForceShieldSpecial", "ChronoSphereSpecial", "LightningStormSpecial",
                 "IronCurtainSpecial", "NukeSpecial", "GeneticConverterSpecial",
                 "PsychicDominatorSpecial"],
    nukeSpecial: "NukeSpecial",
    heroes: ["TANY", "BORIS", "YURIPR"],
    bonus: ["GAOREP", "NAINDP", "NACLON"],
    settingsIni: "RA2MD.INI",
    exe: ["gamemd.exe", "ra2md.exe"]
  },
  ra2: {
    key: "ra2",
    label: "Red Alert 2",
    rulesFile: "rules.ini",
    source: "rules.ini",
    swBuildings: ["GACSPH", "GAWEAT", "NAIRON", "NAMISL"],
    swSpecials: ["ChronoSphereSpecial", "LightningStormSpecial", "IronCurtainSpecial",
                 "MultiSpecial"],
    nukeSpecial: "MultiSpecial",
    heroes: ["TANY"],
    bonus: ["GAOREP"],
    settingsIni: "RA2.INI",
    exe: ["game.exe", "ra2.exe"]
  }
};

/* ------------------------------------------------------------------- config */

function loadCfg() {
  var cfg = {};
  var k;
  for (k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { cfg[k] = DEFAULTS[k]; } }
  if (exists(CFG_PATH)) {
    var lines = readLines(CFG_PATH);
    for (var i = 0; i < lines.length; i++) {
      var raw = trim(lines[i]);
      if (raw === "" || raw.charAt(0) === ";" || raw.charAt(0) === "#") { continue; }
      var eq = raw.indexOf("=");
      if (eq < 1) { continue; }
      var key = trim(raw.substring(0, eq));
      var val = trim(raw.substring(eq + 1));
      for (k in DEFAULTS) {
        if (DEFAULTS.hasOwnProperty(k) && lower(k) === lower(key)) { cfg[k] = val; }
      }
    }
  }

  /* Settings written by an older version used to give the AI the same bonuses
     as the player (instant build speed, unlimited heroes/extra buildings).
     Old files are moved to the "player only" defaults: the AI plays vanilla. */
  var cv = cfg.CfgVer ? parseInt(cfg.CfgVer, 10) : 0;
  if (!(cv >= 3)) {
    if (exists(CFG_PATH)) {
      cfg.SandboxSW = "player";
      cfg.Heroes = "normal";
      cfg.BonusBuildings = "normal";
      cfg.BuildSpeed = "normal";
      cfg.FairAI = "yes";
      cfg.AIDifficulty = "1";
    }
    cfg.CfgVer = "3";
  }
  return cfg;
}

function saveCfg(cfg) {
  ensureDir(CFG_DIR);
  var order = ["Target", "SandboxSW", "SWRecharge", "Heroes", "BonusBuildings",
               "RevealMap", "BigBoom", "BuildSpeed", "SellRefund", "FairAI",
               "Money", "UnitCount", "TechLevel", "GameSpeed", "Crates",
               "ShortGame", "FogOfWar", "AIPlayers", "AIDifficulty", "CarpetNuke",
               "Patches", "KitCost", "CfgVer", "GameDir"];
  var out = [];
  out.push("; Red Alert 2 Sandbox Mod - settings");
  out.push("; Can be edited by hand or from the mod menu (SandboxMod.bat).");
  out.push("");
  out.push("[Sandbox]");
  for (var i = 0; i < order.length; i++) {
    out.push(order[i] + "=" + cfg[order[i]]);
  }
  writeLines(CFG_PATH, out);
}

/* -------------------------------------------------------------- patch logic */

function swRechargeValue(mode) {
  if (mode === "instant") { return "0.01"; }   /* ~0.6 seconds - as good as no cooldown */
  if (mode === "fast") { return "1"; }         /* 1 minute */
  return null;
}

function buildSpeedValue(mode) {
  if (mode === "instant") { return ".1"; }
  if (mode === "fast") { return ".4"; }
  return null;
}

/* Applies the whole sandbox set to a rules file. Returns array of warnings. */
function applyPatches(lines, game, cfg) {
  var warn = [];
  var i;
  var mode = lower(trim(cfg.Patches));
  if (mode === "" ) { mode = "full"; }
  if (mode === "none") { return warn; }        /* test run: base rules, no edits */
  var safeOnly = (mode === "safe");            /* only value swaps, no flags/inserts */

  function set(sec, key, val) {
    if (!iniSet(lines, sec, key, val, false)) {
      warn.push("section [" + sec + "] not found (key " + key + ")");
    }
  }
  function setIfPresent(sec, key, val) {
    iniSet(lines, sec, key, val, true);
  }

  /* --- 1/2. superweapons ------------------------------------------------- */
  /* mode "player" (default): the vanilla superweapons stay exactly as they are,
     so the AI keeps its normal one-charge-per-type behaviour, and the player
     gets a separate sandbox set of superweapons that the AI never builds.
     mode "all": the old behaviour - everybody gets instant unlimited toys.
     mode "off": no superweapon changes at all.                              */
  var swMode = lower(trim(cfg.SandboxSW));
  if (swMode === "") { swMode = "player"; }
  var rt = swRechargeValue(lower(cfg.SWRecharge));
  if (rt === null) { rt = "0.05"; }

  if (swMode === "all") {
    for (i = 0; i < game.swBuildings.length; i++) {
      set(game.swBuildings[i], "BuildLimit", "-1");
      setIfPresent(game.swBuildings[i], "Power", "0");
    }
    for (i = 0; i < game.swSpecials.length; i++) {
      set(game.swSpecials[i], "RechargeTime", rt);
    }
  } else if (swMode === "player") {
    installSandboxSuperweapons(lines, game, cfg, rt, warn);
  }

  /* --- 3. heroes --------------------------------------------------------- */
  if (lower(cfg.Heroes) === "unlimited") {
    for (i = 0; i < game.heroes.length; i++) {
      setIfPresent(game.heroes[i], "BuildLimit", "-1");
    }
  }

  /* --- 4. bonus structures (ore purifier / industrial plant / cloning) --- */
  if (lower(cfg.BonusBuildings) === "unlimited") {
    for (i = 0; i < game.bonus.length; i++) {
      setIfPresent(game.bonus[i], "BuildLimit", "-1");
    }
  }

  /* --- 5. bigger, prettier explosions ----------------------------------- */
  if (!safeOnly && lower(cfg.BigBoom) === "yes") {
    setIfPresent("NUKE", "CellSpread", "14");
    setIfPresent("NukePayload", "Damage", "1200");
    setIfPresent("NukePayload", "RadLevel", "800");
    var carpet = intVal(cfg.CarpetNuke, 6);
    if (carpet < 1) { carpet = 1; }
    if (carpet > 10) { carpet = 10; }
    set(game.nukeSpecial, "LineMultiplier", String(carpet));
  }

  /* --- 6. reveal the whole map ------------------------------------------ */
  if (!safeOnly && lower(cfg.RevealMap) === "yes") {
    set("MultiplayerDialogSettings", "Shroud", "no");
    setIfPresent("General", "ShroudGrow", "no");
  } else if (!safeOnly) {
    setIfPresent("MultiplayerDialogSettings", "Shroud", "yes");
  }

  /* --- 7. construction speed -------------------------------------------- */
  var bs = buildSpeedValue(lower(cfg.BuildSpeed));
  if (bs !== null) { setIfPresent("General", "BuildSpeed", bs); }

  /* --- 8. sell refund --------------------------------------------------- */
  if (lower(cfg.SellRefund) === "100") {
    setIfPresent("General", "RefundPercent", "100%");
  }

  /* --- 9. skirmish defaults --------------------------------------------- */
  /* only the *defaults* are touched: MinMoney / MinUnitCount / MaxUnitCount stay
     as the engine has them, so the skirmish dropdown never has to grow beyond
     the size the exe allocates for it (that is a hardcoded limit) */
  if (!safeOnly) {
  var maxMoney = intVal(iniGet(lines, "MultiplayerDialogSettings", "MaxMoney"), 0);
  var minMoney = intVal(iniGet(lines, "MultiplayerDialogSettings", "MinMoney"), 0);
  var money = intVal(cfg.Money, 40000);
  if (maxMoney > 0 && money > maxMoney) {
    setIfPresent("MultiplayerDialogSettings", "MaxMoney", String(money));
  }
  if (minMoney > 0 && money < minMoney) { money = minMoney; }
  setIfPresent("MultiplayerDialogSettings", "Money", String(money));
  var units = intVal(cfg.UnitCount, 10);
  var maxUnits = intVal(iniGet(lines, "MultiplayerDialogSettings", "MaxUnitCount"), 0);
  if (maxUnits > 0 && units > maxUnits) { units = maxUnits; }
  setIfPresent("MultiplayerDialogSettings", "UnitCount", String(units));
  setIfPresent("MultiplayerDialogSettings", "TechLevel", String(intVal(cfg.TechLevel, 10)));
  setIfPresent("MultiplayerDialogSettings", "GameSpeed", String(intVal(cfg.GameSpeed, 1)));
  setIfPresent("MultiplayerDialogSettings", "AIPlayers", String(intVal(cfg.AIPlayers, 2)));
  setIfPresent("MultiplayerDialogSettings", "AIDifficulty", String(intVal(cfg.AIDifficulty, 2)));
  setIfPresent("MultiplayerDialogSettings", "Bases", "yes");
  if (lower(cfg.Crates) === "yes") {
    setIfPresent("MultiplayerDialogSettings", "Crates", "yes");
  } else {
    setIfPresent("MultiplayerDialogSettings", "Crates", "no");
  }
  setIfPresent("MultiplayerDialogSettings", "ShortGame", lower(cfg.ShortGame) === "yes" ? "yes" : "no");
  setIfPresent("MultiplayerDialogSettings", "FogOfWar", lower(cfg.FogOfWar) === "yes" ? "yes" : "no");
  }

  /* --- 10. honest AI (no money cheating) -------------------------------- */
  if (!safeOnly && lower(cfg.FairAI) === "yes") {
    /* money cheats: 100% = no bonus, no free virtual ore purifiers */
    setIfPresent("General", "MultiplayerAICM", "100,100,100");
    setIfPresent("General", "AIVirtualPurifiers", "0,0,0");

    /* Difficulty sections work "inverted" for the computer in skirmish:
       the human player always reads [Normal], the Brutal AI reads [Easy],
       the medium AI reads [Normal], the Easy AI reads [Difficult].
       Vanilla [Easy] has ROF=.8 (computer fires 25% faster) and BuildTime=.8
       - i.e. exactly the bonuses Brutal AI gets over the player. Setting the
       section to neutral values removes them: the human is untouched because
       he never reads [Easy]. BuildTime/BuildDelay/RepairDelay only affect the
       computer, so raising them slows the AI's development, not the player's. */
    iniSet(lines, "Easy", "ROF", "1.0", false);
    iniSet(lines, "Easy", "FirePower", "1.0", false);
    iniSet(lines, "Easy", "Armor", "1.0", false);
    iniSet(lines, "Easy", "Groundspeed", "1.0", false);
    iniSet(lines, "Easy", "Airspeed", "1.0", false);
    iniSet(lines, "Easy", "Cost", "1.0", false);
    iniSet(lines, "Easy", "BuildTime", "1.5", false);
    iniSet(lines, "Easy", "BuildDelay", ".3", false);
    iniSet(lines, "Easy", "RepairDelay", ".2", false);
    iniSet(lines, "Normal", "BuildTime", "1.2", false);
    iniSet(lines, "Normal", "BuildDelay", ".15", false);
    iniSet(lines, "Normal", "RepairDelay", ".1", false);
  }

  return warn;
}

/* --------------------------------------------- extra superweapon types (INI) */
/* The engine grants one charge per superweapon TYPE per house - that is a
   hardcoded rule. The way around it inside the INI files is to declare extra
   superweapon types (and extra buildings that grant them): each type gets its
   own independent charge, so several strikes can really be launched at once.
   Vanilla art is reused through Image=, so no new graphics are needed. */

function bodyOf(lines, range) {
  var out = [];
  for (var i = range[0] + 1; i < range[1]; i++) { out.push(lines[i]); }
  return out;
}

function setInBody(body, key, value, addIfMissing) {
  var re = new RegExp("^\\s*" + key + "\\s*=", "i");
  for (var i = 0; i < body.length; i++) {
    if (re.test(body[i])) { body[i] = key + "=" + value; return; }
  }
  if (addIfMissing) { body.push(key + "=" + value); }
}

function removeInBody(body, key) {
  var re = new RegExp("^\\s*" + key + "\\s*=", "i");
  for (var i = body.length - 1; i >= 0; i--) {
    if (re.test(body[i])) { body.splice(i, 1); }
  }
}

/* keep the art of the original: if the section already points somewhere with
   Image=, reuse that value; otherwise point at the section's own art. */
function ensureImage(body, ownName) {
  for (var i = 0; i < body.length; i++) {
    if (/^\s*Image\s*=/i.test(body[i])) { return; }
  }
  body.push("Image=" + ownName);
}

function listInfo(lines, listName) {
  var r = iniFindSection(lines, listName);
  if (r === null) { return null; }
  var max = 0, insertAt = r[1];
  for (var i = r[0] + 1; i < r[1]; i++) {
    var m = /^\s*(\d+)\s*=\s*(.+?)\s*$/.exec(lines[i]);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) { max = n; }
      insertAt = i + 1;
    }
  }
  return { max: max, insertAt: insertAt };
}

function installSandboxSuperweapons(lines, game, cfg, rt, warn) {
  var inserts = [];
  var blocks = [];
  var swList = listInfo(lines, "SuperWeaponTypes");
  var bList = listInfo(lines, "BuildingTypes");
  var cost = intVal(cfg.KitCost, 1500);
  var made = 0;

  for (var i = 0; i < game.swBuildings.length; i++) {
    var name = game.swBuildings[i];
    var range = iniFindSection(lines, name);
    if (range === null) { warn.push("\u043D\u0435\u0442 \u0441\u0435\u043A\u0446\u0438\u0438 [" + name + "]"); continue; }

    var cloneName = name + "SB";
    if (iniFindSection(lines, cloneName) !== null) { continue; }

    var swType = null;
    for (var j = range[0] + 1; j < range[1]; j++) {
      var m = /^\s*SuperWeapon\s*=\s*(\S+)/i.exec(lines[j]);
      if (m) { swType = m[1]; break; }
    }
    if (swType === null) { continue; }

    var cloneSW = swType + "SB";
    var swRange = iniFindSection(lines, swType);

    /* building: same art, same name, but the AI never builds it */
    var bBody = bodyOf(lines, range);
    setInBody(bBody, "SuperWeapon", cloneSW, true);
    ensureImage(bBody, name);
    setInBody(bBody, "AIBuildThis", "no", true);
    setInBody(bBody, "BuildLimit", "-1", true);
    setInBody(bBody, "Power", "0", false);
    setInBody(bBody, "Cost", String(cost), false);
    setInBody(bBody, "Adjacent", "2", false);

    /* Give it its own label so it cannot be mixed up with the vanilla building
       (the vanilla one keeps its 10 minute recharge). Dropping UIName makes the
       game show the plain Name= text instead of the CSF string. */
    var origLabel = "";
    for (var q = 0; q < bBody.length; q++) {
      var nm = /^\s*Name\s*=\s*(.*)$/i.exec(bBody[q]);
      if (nm) { origLabel = trim(nm[1]); break; }
    }
    removeInBody(bBody, "UIName");
    setInBody(bBody, "Name", "SANDBOX " + (origLabel === "" ? name : origLabel), false);

    /* superweapon: instant recharge, own sidebar button */
    var swBody = [];
    if (swRange !== null) { swBody = bodyOf(lines, swRange); }
    setInBody(swBody, "RechargeTime", rt, true);

    blocks.push("");
    blocks.push("; ---- Sandbox Mod: player-only superweapon (the AI does not build it)");
    blocks.push("[" + cloneName + "]");
    for (var b = 0; b < bBody.length; b++) { blocks.push(bBody[b]); }
    blocks.push("");
    blocks.push("[" + cloneSW + "]");
    for (var w = 0; w < swBody.length; w++) { blocks.push(swBody[w]); }

    if (bList !== null) {
      inserts.push({ pos: bList.insertAt, text: (bList.max + 1 + made) + "=" + cloneName });
    }
    if (swList !== null) {
      inserts.push({ pos: swList.insertAt, text: (swList.max + 1 + made) + "=" + cloneSW });
    }
    made++;
  }

  if (made === 0) { return; }

  inserts.sort(function (a, b) { return b.pos - a.pos; });
  for (var k = 0; k < inserts.length; k++) { lines.splice(inserts[k].pos, 0, inserts[k].text); }
  for (var z = 0; z < blocks.length; z++) { lines.push(blocks[z]); }
}

/* ------------------------------------------------------------------- prepare */

function gameDir(cfg) {
  if (cfg && trim(cfg.GameDir) !== "" && dirExists(trim(cfg.GameDir))) {
    return trim(cfg.GameDir);
  }
  return fso.GetParentFolderName(MOD_DIR);
}

function pickGames(cfg) {
  var t = lower(cfg.Target);
  var out = [];
  if (t === "both" || t === "yr") { out.push(GAMES.yr); }
  if (t === "both" || t === "ra2") { out.push(GAMES.ra2); }
  if (out.length === 0) { out.push(GAMES.yr); }
  return out;
}

function findSettingsIni(gdir, name) {
  /* Windows is case insensitive, but keep the original casing for reporting */
  var direct = join(gdir, name);
  if (exists(direct)) { return direct; }
  var up = join(gdir, name.toUpperCase());
  if (exists(up)) { return up; }
  return null;
}

function prepare(cfg, log) {
  var gdir = gameDir(cfg);
  var games = pickGames(cfg);
  var state = [];
  var i, g;

  if (!dirExists(gdir)) {
    log("\u0418\u0433\u0440\u043E\u0432\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: " + gdir);
    return { ok: false, reason: "no-game-dir", dir: gdir };
  }

  /* write test - the game folder may be read only (Program Files) */
  var probe = join(gdir, ".sandbox_write_test");
  try {
    writeLines(probe, ["test"]);
    deleteFile(probe);
  } catch (e) {
    log("\u041D\u0435\u0442 \u043F\u0440\u0430\u0432 \u043D\u0430 \u0437\u0430\u043F\u0438\u0441\u044C \u0432 \u0438\u0433\u0440\u043E\u0432\u0443\u044E \u043F\u0430\u043F\u043A\u0443: " + gdir);
    log("\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u043E\u0442 \u0438\u043C\u0435\u043D\u0438 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430 \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0438\u0442\u0435 \u0438\u0433\u0440\u0443.");
    return { ok: false, reason: "readonly", dir: gdir };
  }

  ensureDir(BACKUP_DIR);
  ensureDir(STATE_DIR);

  for (i = 0; i < games.length; i++) {
    g = games[i];
    var src = join(RULES_DIR, g.source);
    var custom = join(join(RULES_DIR, "custom"), g.source);
    if (exists(custom)) {
      src = custom;
      log("  " + g.label + ": \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0441\u0432\u043E\u0439 \u0431\u0430\u0437\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B rules\\custom\\" + g.source);
    }
    if (!exists(src)) {
      log("\u0412\u043D\u0438\u043C\u0430\u043D\u0438\u0435: \u043D\u0435\u0442 \u0431\u0430\u0437\u043E\u0432\u043E\u0433\u043E \u0444\u0430\u0439\u043B\u0430 " + src + " (\u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E " + g.label + ")");
      continue;
    }
    var lines = readLines(src);
    var warn = applyPatches(lines, g, cfg);
    for (var w = 0; w < warn.length; w++) { log("  \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: [" + g.label + "] " + warn[w]); }
    lines.unshift(MARKER);

    var target = join(gdir, g.rulesFile);
    var backup = join(BACKUP_DIR, g.rulesFile + ".orig");
    if (exists(target) && !isOurs(target)) {
      /* a foreign rules file (vanilla drop-in or another mod) - remember it */
      copyFile(target, backup);
      state.push("backup|" + g.rulesFile);
    } else if (exists(target)) {
      /* our own leftover after a crash / killed console window */
      if (exists(backup)) { state.push("backup|" + g.rulesFile); }
      else { state.push("create|" + g.rulesFile); }
    } else {
      deleteFile(backup);
      state.push("create|" + g.rulesFile);
    }
    writeLines(target, lines);
    log("  " + g.label + ": " + g.rulesFile + " \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D (" + lines.length + " \u0441\u0442\u0440\u043E\u043A)");
  }

  /* skirmish defaults, so the player does not have to click anything */
  for (i = 0; i < games.length; i++) {
    g = games[i];
    var ini = findSettingsIni(gdir, g.settingsIni);
    if (ini === null) { continue; }
    var iniBackup = join(BACKUP_DIR, fso.GetFileName(ini) + ".orig");
    /* the very first copy of the game ini is the valuable one - keep it */
    if (!exists(iniBackup)) { copyFile(ini, iniBackup); }
    var il = readLines(ini);
    if (patchSkirmishIni(il, cfg)) {
      writeLines(ini, il);
      log("  " + fso.GetFileName(ini) + ": \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0441\u043A\u0438\u0440\u043C\u0438\u0448\u0430 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u044B");
    }
    state.push("ini|" + fso.GetFileName(ini));
  }

  writeLines(STATE_PATH, state);
  return { ok: true, dir: gdir };
}

function patchSkirmishIni(lines, cfg) {
  var changed = false;
  var pairs = [
    ["Credits", String(intVal(cfg.Money, 40000))],
    ["UnitCount", String(intVal(cfg.UnitCount, 10))],
    ["GameSpeed", String(intVal(cfg.GameSpeed, 1))],
    ["ShortGame", lower(cfg.ShortGame) === "yes" ? "yes" : "no"],
    ["SuperWeaponsAllowed", "yes"],
    ["CratesAppear", lower(cfg.Crates) === "yes" ? "yes" : "no"],
    ["MCVRepacks", "yes"],
    ["BuildOffAlly", "yes"]
  ];
  for (var i = 0; i < pairs.length; i++) {
    if (iniSet(lines, "Skirmish", pairs[i][0], pairs[i][1], true)) { changed = true; }
  }
  return changed;
}

/* ------------------------------------------------------------------- restore */

function restore(log, seenOnly) {
  var restored = 0, removed = 0, kept = 0;
  if (!exists(STATE_PATH)) { return { restored: 0, removed: 0, kept: 0 }; }

  var gdir = gameDir(loadCfg());
  var state = readLines(STATE_PATH);

  for (var i = 0; i < state.length; i++) {
    var parts = String(state[i]).split("|");
    var kind = parts[0];
    var name = parts[1];
    if (!name) { continue; }
    var target = join(gdir, name);
    var backup = join(BACKUP_DIR, name + ".orig");

    if (kind === "backup") {
      if (exists(backup)) { copyFile(backup, target); restored++; }
    } else if (kind === "create") {
      if (isOurs(target)) { deleteFile(target); removed++; }
    } else if (kind === "ini") {
      kept++; /* skirmish settings are left in place on purpose */
    }
  }
  deleteFile(STATE_PATH);
  return { restored: restored, removed: removed, kept: kept };
}

function isOurs(path) {
  if (!exists(path)) { return false; }
  try {
    var ts = fso.OpenTextFile(path, 1, false, -2);
    var first = ts.AtEndOfStream ? "" : ts.ReadLine();
    ts.Close();
    return trim(first) === trim(MARKER);
  } catch (e) {
    return false;
  }
}

/* ----------------------------------------------------------------- uninstall */

/* Puts everything back: generated rules, patched game INIs, and removes the
   backup copies afterwards so the folder is clean. */
function uninstall(log) {
  var cfg = loadCfg();
  var gdir = gameDir(cfg);
  var restored = 0, removed = 0;
  var names = [
                      GAMES.yr.rulesFile,  GAMES.ra2.rulesFile,
    GAMES.yr.settingsIni, GAMES.ra2.settingsIni
  ];

  if (exists(STATE_PATH)) {
    var st = readLines(STATE_PATH);
    for (var i = 0; i < st.length; i++) {
      var parts = String(st[i]).split("|");
      if (parts.length > 1 && trim(parts[1]) !== "") { names.push(trim(parts[1])); }
    }
  }

  names = dedupe(names);
  for (var n = 0; n < names.length; n++) {
    var name = names[n];
    var target = join(gdir, name);
    var backup = join(BACKUP_DIR, name + ".orig");
    if (exists(backup)) {
      copyFile(backup, target);
      deleteFile(backup);
      restored++;
    } else if (isOurs(target)) {
      deleteFile(target);
      removed++;
    }
  }
  deleteFile(STATE_PATH);

  log("\u0423\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u043E. \u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E \u0444\u0430\u0439\u043B\u043E\u0432: " + restored + ", \u0443\u0434\u0430\u043B\u0435\u043D\u043E: " + removed + ".");
  log("\u0418\u0433\u0440\u043E\u0432\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u0432\u0435\u0440\u043D\u0443\u043B\u0430\u0441\u044C \u0432 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435. \u0421\u0430\u043C\u0443 \u043F\u0430\u043F\u043A\u0443 SandboxMod \u043C\u043E\u0436\u043D\u043E \u0443\u0434\u0430\u043B\u0438\u0442\u044C.");
  return 0;
}

function dedupe(list) {
  var out = [], i, j, dup;
  for (i = 0; i < list.length; i++) {
    dup = false;
    for (j = 0; j < out.length; j++) {
      if (lower(out[j]) === lower(list[i])) { dup = true; break; }
    }
    if (!dup) { out.push(list[i]); }
  }
  return out;
}

/* ------------------------------------------------------------------ launching */

function findExe(gdir, gameKey) {
  var candidates;
  if (gameKey === "yr") { candidates = ["gamemd.exe"]; }
  else if (gameKey === "ra2") { candidates = ["game.exe"]; }
  else { candidates = ["gamemd.exe", "game.exe", "ra2md.exe", "ra2.exe"]; }
  for (var i = 0; i < candidates.length; i++) {
    if (exists(join(gdir, candidates[i]))) { return join(gdir, candidates[i]); }
  }
  return null;
}

/* The Steam build ships small DRM-wrapped launchers next to the real games:
   Ra2.exe -> game.exe (Red Alert 2), RA2MD.exe -> gamemd.exe (Yuri's Revenge).
   A launcher starts the game and exits at once, so waiting for the launcher is
   not the same as waiting for the game. We therefore run the real executable. */
var LAUNCHERS = { "ra2.exe": ["game.exe"], "ra2md.exe": ["gamemd.exe"] };

function firstToken(cmdLine) {
  var s = trim(cmdLine);
  if (s.charAt(0) === '"') {
    var end = s.indexOf('"', 1);
    return end > 0 ? s.substring(1, end) : s.substring(1);
  }
  var sp = s.indexOf(" ");
  return sp > 0 ? s.substring(0, sp) : s;
}

function baseName(path) {
  var s = String(path).replace(/^.*[\\\/]/, "");
  return lower(s);
}

/* Returns a replacement command line (the real game exe) or null. */
function resolveLauncher(gdir, cmdLine) {
  var exe = firstToken(cmdLine);
  var wants = LAUNCHERS[baseName(exe)];
  if (!wants) { return null; }
  for (var i = 0; i < wants.length; i++) {
    var candidate = join(gdir, wants[i]);
    if (exists(candidate)) { return '"' + candidate + '"'; }
  }
  return null;
}

/* Is a game process still alive? Used when the game was started indirectly. */
function gameProcessAlive() {
  try {
    var wmi = GetObject("winmgmts:\\\\.\\root\\cimv2");
    var col = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name='gamemd.exe' OR Name='game.exe'");
    return (col.Count > 0);
  } catch (e) {
    return false;
  }
}

function waitForGameExit(log, maxMinutes) {
  if (!gameProcessAlive()) { return; }
  log("\u0418\u0433\u0440\u0430 \u0435\u0449\u0451 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 (\u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u0447\u0435\u0440\u0435\u0437 \u043B\u0430\u0443\u043D\u0447\u0435\u0440) \u2014 \u0436\u0434\u0443 \u0435\u0451 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F, \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043D\u0435 \u0442\u0440\u043E\u0433\u0430\u044E...");
  var waited = 0;
  while (gameProcessAlive() && waited < maxMinutes * 30) {
    WScript.Sleep(2000);
    waited++;
  }
}

function runAndWait(gdir, cmdLine) {
  var oldDir = sh.CurrentDirectory;
  try { sh.CurrentDirectory = gdir; } catch (e) {}
  var rc = sh.Run(cmdLine, 1, true);
  try { sh.CurrentDirectory = oldDir; } catch (e) {}
  return rc;
}

function sandboxSession(cfg, cmdLine, log) {
  var r = prepare(cfg, log);
  if (!r.ok) { return 1; }
  log("");
  log("\u0417\u0430\u043F\u0443\u0441\u043A: " + cmdLine);

  var real = resolveLauncher(r.dir, cmdLine);
  if (real !== null) {
    log("Steam \u043F\u0435\u0440\u0435\u0434\u0430\u043B \u043B\u0430\u0443\u043D\u0447\u0435\u0440 (" + fso.GetFileName(firstToken(cmdLine)) + "), \u0430 \u043E\u043D \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u0442 \u0438\u0433\u0440\u0443 \u0438");
    log("\u0441\u0440\u0430\u0437\u0443 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u2014 \u0438\u0437-\u0437\u0430 \u044D\u0442\u043E\u0433\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043C\u043E\u0433\u043B\u0438 \u043E\u0442\u043A\u0430\u0442\u044B\u0432\u0430\u0442\u044C\u0441\u044F \u043F\u0440\u044F\u043C\u043E \u0432\u043E \u0432\u0440\u0435\u043C\u044F \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438.");
    log("\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0441\u0430\u043C\u0443 \u0438\u0433\u0440\u0443: " + real);
    cmdLine = real;
  }
  log("");
  log("\u0418\u0433\u0440\u0430 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430. \u041E\u043A\u043D\u043E \u043D\u0435 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0439\u0442\u0435: \u043F\u043E\u0441\u043B\u0435 \u0432\u044B\u0445\u043E\u0434\u0430 \u0444\u0430\u0439\u043B\u044B \u0438\u0433\u0440\u044B \u0431\u0443\u0434\u0443\u0442 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0435\u043D\u044B \u0432 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435.");
  log("");
  var rc = runAndWait(r.dir, cmdLine);
  waitForGameExit(log, 480);
  var st = restore(log, true);
  log("");
  log("\u0418\u0433\u0440\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430 (\u043A\u043E\u0434 " + rc + "). \u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E \u0444\u0430\u0439\u043B\u043E\u0432: " + st.restored +
      ", \u0443\u0434\u0430\u043B\u0435\u043D\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445: " + st.removed + ".");
  log("\u0418\u0433\u0440\u043E\u0432\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u0441\u043D\u043E\u0432\u0430 \u0432 \u0432\u0430\u043D\u0438\u043B\u044C\u043D\u043E\u043C \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0438.");
  if (LOG_PATH !== "") { log("\u041B\u043E\u0433 \u044D\u0442\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438: " + LOG_PATH); }
  if (rc !== 0) {
    log("");
    log("\u041A\u043E\u0434 \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u0430 \u043D\u0435 \u043D\u043E\u043B\u044C \u2014 \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u0438\u0433\u0440\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0430\u0441\u044C \u0441 \u043E\u0448\u0438\u0431\u043A\u043E\u0439.");
    log("\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C: \u0432 \u043C\u0435\u043D\u044E \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 23) \u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A -> none \u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u043D\u043E\u0432\u0430.");
    log("  * \u043E\u0448\u0438\u0431\u043A\u0430 \u043E\u0441\u0442\u0430\u043B\u0430\u0441\u044C  -> \u0434\u0435\u043B\u043E \u043D\u0435 \u0432 \u043F\u0430\u0442\u0447\u0430\u0445, \u0430 \u0432 \u0431\u0430\u0437\u043E\u0432\u043E\u043C \u0444\u0430\u0439\u043B\u0435 \u043F\u0440\u0430\u0432\u0438\u043B / \u0441\u0430\u043C\u043E\u0439 \u0438\u0433\u0440\u0435;");
    log("  * \u043E\u0448\u0438\u0431\u043A\u0438 \u043D\u0435\u0442       -> \u043F\u0430\u0442\u0447\u0438, \u0441\u0443\u0437\u044C\u0442\u0435 \u0438\u0445 \u0440\u0435\u0436\u0438\u043C\u043E\u043C safe \u0438 \u043E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u043F\u0443\u043D\u043A\u0442\u044B 8-12.");
  }
  return 0;
}

/* ---------------------------------------------------------------- diagnostics */

var REQUIRED_SECTIONS = ["General", "MultiplayerDialogSettings", "BuildingTypes",
  "InfantryTypes", "VehicleTypes", "AircraftTypes", "Warheads", "SuperWeaponTypes",
  "AudioVisual", "AI", "Animations", "OverlayTypes", "TerrainTypes"];

function fileVersion(path) {
  try {
    var ns = sh.NameSpace(fso.GetParentFolderName(path));
    var item = ns.ParseName(fso.GetFileName(path));
    if (!item) { return ""; }
    var v = item.ExtendedProperty("FileVersion");
    return v ? String(v) : "";
  } catch (e) { return ""; }
}

function diagnostics(log) {
  var cfg = loadCfg();
  var gdir = gameDir(cfg);
  var ok = true;
  log("\u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430 Red Alert 2 Sandbox Mod");
  log("-----------------------------------");
  log("\u041F\u0430\u043F\u043A\u0430 \u043C\u043E\u0434\u0430  : " + MOD_DIR);
  log("\u041F\u0430\u043F\u043A\u0430 \u0438\u0433\u0440\u044B  : " + gdir);
  log("\u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A: " + cfg.Patches);
  log("\u0426\u0435\u043B\u044C        : " + cfg.Target);
  log("\u0424\u0430\u0439\u043B \u043F\u0440\u0430\u0432\u0438\u043B : " + (dirExists(RULES_DIR) ? RULES_DIR : "\u041D\u0415 \u041D\u0410\u0419\u0414\u0415\u041D"));
  ok = ok && dirExists(RULES_DIR);

  var keys = ["yr", "ra2"];
  for (var i = 0; i < keys.length; i++) {
    var g = GAMES[keys[i]];
    var src = join(RULES_DIR, g.source);
    if (exists(join(join(RULES_DIR, "custom"), g.source))) {
      src = join(join(RULES_DIR, "custom"), g.source);
    }
    if (!exists(src)) { log(g.label + ": \u043D\u0435\u0442 " + g.source); ok = false; continue; }
    var lines = readLines(src);

    /* 1. is this really a complete rules file of the right game? */
    var missing = [];
    for (var r = 0; r < REQUIRED_SECTIONS.length; r++) {
      if (iniFindSection(lines, REQUIRED_SECTIONS[r]) === null) { missing.push(REQUIRED_SECTIONS[r]); }
    }
    var name = iniGet(lines, "General", "Name");
    var warn = applyPatches(lines, g, cfg);

    log("");
    log(g.label + " (" + g.source + ")");
    log("  \u0441\u0442\u0440\u043E\u043A \u0432 \u0431\u0430\u0437\u043E\u0432\u043E\u043C \u0444\u0430\u0439\u043B\u0435: " + lines.length + ", \u0441\u0435\u043A\u0446\u0438\u0439: " + countSections(lines));
    log("  \u0438\u043C\u044F \u043F\u0440\u0430\u0432\u0438\u043B: " + (name === null ? "\u043D\u0435\u0442 [General] Name" : name));
    if (missing.length > 0) {
      log("  \u041E\u0422\u0421\u0423\u0422\u0421\u0422\u0412\u0423\u042E\u0422 \u0441\u0435\u043A\u0446\u0438\u0438: " + missing.join(", "));
      ok = false;
    } else {
      log("  \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u0441\u0435\u043A\u0446\u0438\u0438: \u0432\u0441\u0435 \u043D\u0430 \u043C\u0435\u0441\u0442\u0435");
    }
    if (warn.length > 0) {
      log("  \u043F\u0440\u0430\u0432\u043A\u0438 \u043D\u0435 \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043B\u0438\u0441\u044C: " + warn.length);
      for (var w = 0; w < warn.length; w++) { log("   " + warn[w]); ok = false; }
    } else {
      log("  \u043F\u0440\u0430\u0432\u043A\u0438 \u043F\u0440\u0438\u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F \u0431\u0435\u0437 \u043E\u0448\u0438\u0431\u043E\u043A");
    }
  }

  var exeYr = findExe(gdir, "yr");
  var exeRa2 = findExe(gdir, "ra2");
  log("");
  log("gamemd.exe : " + (exeYr ? "\u043D\u0430\u0439\u0434\u0435\u043D, \u0432\u0435\u0440\u0441\u0438\u044F " + (fileVersion(exeYr) || "?") : "\u043D\u0435\u0442"));
  log("game.exe   : " + (exeRa2 ? "\u043D\u0430\u0439\u0434\u0435\u043D, \u0432\u0435\u0440\u0441\u0438\u044F " + (fileVersion(exeRa2) || "?") : "\u043D\u0435\u0442"));
  if (!exeYr && !exeRa2) { ok = false; }

  var iniYr = findSettingsIni(gdir, "RA2MD.INI");
  var iniRa2 = findSettingsIni(gdir, "RA2.INI");
  log("RA2MD.INI  : " + (iniYr ? "\u0435\u0441\u0442\u044C" : "\u043D\u0435\u0442"));
  log("RA2.INI    : " + (iniRa2 ? "\u0435\u0441\u0442\u044C" : "\u043D\u0435\u0442"));

  var probe = join(gdir, ".sandbox_write_test");
  try { writeLines(probe, ["x"]); deleteFile(probe); log("\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u043F\u0430\u043F\u043A\u0443 \u0438\u0433\u0440\u044B: ok"); }
  catch (e) { log("\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u043F\u0430\u043F\u043A\u0443 \u0438\u0433\u0440\u044B: \u041D\u0415\u0422 \u041F\u0420\u0410\u0412"); ok = false; }

  log("");
  if (ok) {
    log("\u0418\u0442\u043E\u0433: \u0432\u0441\u0451 \u043D\u0430 \u043C\u0435\u0441\u0442\u0435, \u043C\u043E\u0436\u043D\u043E \u0438\u0433\u0440\u0430\u0442\u044C.");
  } else {
    log("\u0418\u0442\u043E\u0433: \u0435\u0441\u0442\u044C \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u044B, \u0441\u043C. \u0441\u0442\u0440\u043E\u043A\u0438 \u0432\u044B\u0448\u0435.");
  }
  var lastLog = lastLogFile();
  if (lastLog !== "") { log("\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043B\u043E\u0433: " + lastLog); }

  log("");
  log("\u0415\u0441\u043B\u0438 \u0438\u0433\u0440\u0430 \u043F\u0430\u0434\u0430\u0435\u0442 \u0441 'internal error', \u0430 \u0437\u0434\u0435\u0441\u044C \u0432\u0441\u0451 \u0437\u0435\u043B\u0451\u043D\u043E\u0435 \u2014 \u0437\u043D\u0430\u0447\u0438\u0442 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u043B\u0430");
  log("\u0432\u0435\u0440\u0441\u0438\u044F \u0431\u0430\u0437\u043E\u0432\u043E\u0433\u043E \u0444\u0430\u0439\u043B\u0430 \u043F\u0440\u0430\u0432\u0438\u043B. \u041F\u043E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u0440\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A none (\u043C\u0435\u043D\u044E, \u043F\u0443\u043D\u043A\u0442 23):");
  log("  - \u0441 none \u0438\u0433\u0440\u0430 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 -> \u0432\u0438\u043D\u043E\u0432\u0430\u0442\u044B \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u044B\u0435 \u043F\u0440\u0430\u0432\u043A\u0438, \u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 safe;");
  log("  - \u0441 none \u0442\u043E\u0436\u0435 \u043F\u0430\u0434\u0430\u0435\u0442   -> \u0431\u0430\u0437\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B \u043D\u0435 \u043F\u043E\u0434\u0445\u043E\u0434\u0438\u0442 \u044D\u0442\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0435 \u0438\u0433\u0440\u044B,");
  log("    \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 Target=yr (\u0438\u043B\u0438 ra2) \u0438 \u0438\u0433\u0440\u0430\u0439\u0442\u0435 \u0432\u043E \u0432\u0442\u043E\u0440\u0443\u044E \u0438\u0433\u0440\u0443 \u0432\u0430\u043D\u0438\u043B\u044C\u043D\u043E.");
  return ok ? 0 : 1;
}

function lastLogFile() {
  var pointer = join(join(MOD_DIR, "logs"), "last.txt");
  if (!exists(pointer)) { return ""; }
  try {
    var lines = readLines(pointer);
    return lines.length > 0 ? trim(lines[0]) : "";
  } catch (e) {
    return "";
  }
}

function countSections(lines) {
  var n = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { n++; }
  }
  return n;
}

/* ---------------------------------------------------------------- menu (UI) */

function T(s) { return s; }

function diffLabel(v) {
  var n = intVal(v, 1);
  if (n === 0) { return "\u043b\u0435\u0433\u043a\u043e"; }
  if (n === 2) { return "Brutal"; }
  return "\u0441\u0440\u0435\u0434\u043d\u0435";
}

function onOff(v) { return lower(v) === "yes" ? "\u0434\u0430" : "\u043D\u0435\u0442"; }

function menu(cfg, log) {
  var running = true;
  while (running) {
    log("");
    log("=================================================");
    log("        RED ALERT 2  ::  SANDBOX MOD");
    log("=================================================");
    log(" \u041F\u0430\u043F\u043A\u0430 \u0438\u0433\u0440\u044B: " + gameDir(cfg));
    log("");
    log("  1) \u0418\u0433\u0440\u0430\u0442\u044C: Yuri's Revenge");
    log("  2) \u0418\u0433\u0440\u0430\u0442\u044C: Red Alert 2");
    log("  3) \u0418\u0433\u0440\u0430\u0442\u044C \u0442\u0430\u043A, \u043A\u0430\u043A \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E \u0432 Steam     <- Enter");
    log("-------------------------------------------------");
    log("  4)  \u0421\u0443\u043F\u0435\u0440\u043E\u0440\u0443\u0436\u0438\u0435 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B .......... " + swModeLabel(cfg.SandboxSW));
    log("  5)  \u0417\u0430\u0440\u044F\u0434\u043A\u0430 \u0441\u0443\u043F\u0435\u0440\u043E\u0440\u0443\u0436\u0438\u044F ............ " + cfg.SWRecharge + (lower(cfg.SWRecharge) === "instant" ? " (" + T("~0.5 \u0441\u0435\u043a") + ")" : ""));
    log("  6)  \u0413\u0435\u0440\u043E\u0438 \u0431\u0435\u0437 \u043B\u0438\u043C\u0438\u0442\u0430 (\u0438 \u0431\u043E\u0442\u0443) ...... " + (lower(cfg.Heroes) === "unlimited" ? "\u0414\u0410" : "\u043A\u0430\u043A \u0432 \u043E\u0440\u0438\u0433\u0438\u043D\u0430\u043B\u0435"));
    log("  7)  \u0411\u043E\u043D\u0443\u0441\u043D\u044B\u0435 \u0437\u0434\u0430\u043D\u0438\u044F (\u0438 \u0431\u043E\u0442\u0443) ....... " + (lower(cfg.BonusBuildings) === "unlimited" ? "\u0414\u0410" : "\u043A\u0430\u043A \u0432 \u043E\u0440\u0438\u0433\u0438\u043D\u0430\u043B\u0435"));
    log("  8)  \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0432\u0441\u044E \u043A\u0430\u0440\u0442\u0443 .............. " + onOff(cfg.RevealMap));
    log("  9)  \u0411\u043E\u043B\u044C\u0448\u0438\u0435 \u0432\u0437\u0440\u044B\u0432\u044B / \u043A\u043E\u0432\u0440\u043E\u0432\u0430\u044F \u0431\u043E\u043C\u0431\u0451\u0436\u043A\u0430 " + onOff(cfg.BigBoom));
    log(" 10)  \u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u0441\u0442\u0440\u043E\u0438\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 ......... " + cfg.BuildSpeed + (lower(cfg.BuildSpeed) === "normal" ? "" : " (\u0438 \u0431\u043E\u0442\u0443)"));
    log(" 11)  \u0412\u043E\u0437\u0432\u0440\u0430\u0442 \u0434\u0435\u043D\u0435\u0433 \u043F\u0440\u0438 \u043F\u0440\u043E\u0434\u0430\u0436\u0435 ...... " + cfg.SellRefund + "%");
    log(" 12)  \u0427\u0435\u0441\u0442\u043D\u044B\u0439 \u0418\u0418 (\u0431\u0435\u0437 \u0447\u0438\u0442\u043E\u0432) ......... " + onOff(cfg.FairAI));
    log(" 13)  \u0414\u0435\u043D\u0435\u0433 \u043D\u0430 \u0441\u0442\u0430\u0440\u0442\u0435 ................ " + cfg.Money);
    log(" 14)  \u042E\u043D\u0438\u0442\u043E\u0432 \u043D\u0430 \u0441\u0442\u0430\u0440\u0442\u0435 ............... " + cfg.UnitCount);
    log(" 15)  \u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u0438\u0433\u0440\u044B (0..6) ........... " + cfg.GameSpeed);
    log(" 16)  \u0411\u043E\u0442\u043E\u0432 \u043D\u0430 \u043A\u0430\u0440\u0442\u0435 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E .... " + cfg.AIPlayers);
    log(" 17)  \u0421\u043B\u043E\u0436\u043D\u043E\u0441\u0442\u044C \u0431\u043E\u0442\u043E\u0432 (0,1,2) ........ " + cfg.AIDifficulty + " (" + diffLabel(cfg.AIDifficulty) + ")");
    log(" 18)  \u041A\u043E\u0440\u043E\u0442\u043A\u0430\u044F \u0438\u0433\u0440\u0430 .................. " + onOff(cfg.ShortGame));
    log(" 19)  \u0422\u0443\u043C\u0430\u043D \u0432\u043E\u0439\u043D\u044B .................... " + onOff(cfg.FogOfWar));
    log(" 20)  \u041B\u0438\u043D\u0438\u044F \u0443\u0434\u0430\u0440\u0430 (\u043A\u043E\u0432\u0440\u043E\u0432\u0430\u044F) ......... " + cfg.CarpetNuke);
    log("-------------------------------------------------");
    log("-------------------------------------------------");
    log(" 21)  \u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430");
    log(" 22)  \u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0432\u0441\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438");
    log(" 23)  \u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A (\u0434\u043B\u044F \u043E\u0442\u043B\u0430\u0434\u043A\u0438) ... " + cfg.Patches);
    log(" 24)  \u041F\u0440\u0435\u0441\u0435\u0442: " + presetName(cfg));
    log("  0)  \u0412\u044B\u0445\u043E\u0434");
    log("");
    if (lower(cfg.Patches) === "safe") {
      log("  ! \u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A SAFE: \u0431\u0435\u0437 \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0439 \u043A\u0430\u0440\u0442\u044B, \u0418\u0418, \u0431\u043E\u043B\u044C\u0448\u0438\u0445 \u0432\u0437\u0440\u044B\u0432\u043E\u0432 \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A \u0441\u043A\u0438\u0440\u043C\u0438\u0448\u0430.");
    }
    if (lower(cfg.Patches) === "none") {
      log("  ! \u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0430\u0432\u043E\u043A NONE: \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043A\u043B\u0430\u0434\u0443\u0442\u0441\u044F \u043A\u0430\u043A \u0435\u0441\u0442\u044C, \u0411\u0415\u0417 \u043F\u0430\u0442\u0447\u0435\u0439 (\u0442\u0435\u0441\u0442 \u043D\u0430 \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u043E\u0441\u0442\u044C).");
    }
    log("  \u041F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430: \u0441\u043A\u0438\u0440\u043C\u0438\u0448 -> \u0432\u044B\u0431\u043E\u0440 \u0431\u043E\u0442\u043E\u0432 \u0442\u0430\u043C \u0436\u0435, \u0433\u0434\u0435 \u0441\u043B\u043E\u0436\u043D\u043E\u0441\u0442\u044C.");
    log("  \u041F\u0435\u0441\u043E\u0447\u043D\u044B\u0435 \u0441\u0443\u043F\u0435\u0440\u043E\u0440\u0443\u0436\u0438\u044F (\u043F\u0443\u043D\u043A\u0442 4 = '\u0442\u043E\u043B\u044C\u043A\u043E \u043C\u043D\u0435') \u0441\u0442\u0440\u043E\u044F\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E");
    log("  \u043E\u0442 \u043E\u0431\u044B\u0447\u043D\u044B\u0445 \u0438 \u0431\u043E\u0442 \u0438\u0445 \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u043D\u0435 \u0441\u0442\u0440\u043E\u0438\u0442 - \u0443 \u043D\u0435\u0433\u043E \u0432\u0441\u0451 \u043A\u0430\u043A \u0432 \u043E\u0440\u0438\u0433\u0438\u043D\u0430\u043B\u0435.");
    log("  \u0414\u0432\u0430 \u0431\u043E\u0442\u0430 \u0434\u0440\u0443\u0433 \u043F\u0440\u043E\u0442\u0438\u0432 \u0434\u0440\u0443\u0433\u0430: \u043F\u043E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 2 \u0418\u0418 + \u0441\u0435\u0431\u044F, \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435");
    log("  '\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0432\u0441\u044E \u043A\u0430\u0440\u0442\u0443' \u0438 \u043D\u0435 \u0441\u0442\u0440\u043E\u0439\u0442\u0435 \u0431\u0430\u0437\u0443 - \u0431\u0443\u0434\u0435\u0442\u0435 \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u0435\u043C.");
    log("  \u0412 \u0441\u043f\u0438\u0441\u043a\u0435 \u043f\u043e\u0441\u0442\u0440\u043e\u0435\u043a \u043f\u0435\u0441\u043e\u0447\u043d\u044b\u0435 \u0437\u0434\u0430\u043d\u0438\u044f \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u044b SANDBOX ... \u2014 \u0441\u0442\u0440\u043e\u0439\u0442\u0435 \u0438\u043c\u0435\u043d\u043d\u043e \u0438\u0445:");
    log("  \u043e\u0431\u044b\u0447\u043d\u044b\u0435 \u044f\u0434\u0435\u0440\u043d\u0430\u044f \u0448\u0430\u0445\u0442\u0430 \u0438 \u0442.\u043f. \u043e\u0441\u0442\u0430\u043b\u0438\u0441\u044c \u0441 \u0437\u0430\u0440\u044f\u0434\u043a\u043e\u0439 10 \u043c\u0438\u043d\u0443\u0442, \u043a\u0430\u043a \u0432 \u0432\u0430\u043d\u0438\u043b\u0438.");
    log("  \u0427\u0435\u0441\u0442\u043d\u044b\u0439 \u0418\u0418: \u0443 Brutal \u043e\u0442\u043e\u0431\u0440\u0430\u043d\u044b \u0434\u0435\u043d\u044c\u0433\u0438, \u0432\u0438\u0440\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0435 \u043e\u0447\u0438\u0441\u0442\u0438\u0442\u0435\u043b\u0438 \u0438 \u0431\u043e\u043d\u0443\u0441 \u043a \u0441\u0442\u0440\u0435\u043b\u044c\u0431\u0435,");
    log("  \u0430 \u0435\u0433\u043e \u0441\u0442\u0440\u043e\u0438\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u043e \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u044c\u043d\u043e \u0437\u0430\u043c\u0435\u0434\u043b\u0435\u043d\u043e \u2014 \u0431\u044b\u0441\u0442\u0440\u0435\u0435 \u0440\u0430\u0437\u0432\u0438\u0432\u0430\u0435\u0442\u0435\u0441\u044c \u0442\u043e\u043b\u044c\u043a\u043e \u0432\u044b.");
    log("");

    var answer = prompt(log, "\u0412\u044B\u0431\u043E\u0440 [1]: ");
    if (answer === "") { answer = "1"; }

    var n = intVal(answer, -1);
    switch (n) {
      case 1: if (play(cfg, "yr", log)) { return; } break;
      case 2: if (play(cfg, "ra2", log)) { return; } break;
      case 3: if (play(cfg, "auto", log)) { return; } break;
      case 4: cfg.SandboxSW = cycle(cfg.SandboxSW, ["player", "all", "off"]); break;
      case 5: cfg.SWRecharge = cycle(cfg.SWRecharge, ["instant", "fast", "normal"]); break;
      case 6: cfg.Heroes = toggle(cfg.Heroes, "unlimited", "normal"); break;
      case 7: cfg.BonusBuildings = toggle(cfg.BonusBuildings, "unlimited", "normal"); break;
      case 8: cfg.RevealMap = toggle(cfg.RevealMap, "yes", "no"); break;
      case 9: cfg.BigBoom = toggle(cfg.BigBoom, "yes", "no"); break;
      case 10: cfg.BuildSpeed = cycle(cfg.BuildSpeed, ["instant", "fast", "normal"]); break;
      case 11: cfg.SellRefund = cycle(cfg.SellRefund, ["100", "50"]); break;
      case 12: cfg.FairAI = toggle(cfg.FairAI, "yes", "no"); break;
      case 13: cfg.Money = cycle(cfg.Money, ["10000", "20000", "40000", "80000", "100000"]); break;
      case 14: cfg.UnitCount = cycle(cfg.UnitCount, ["1", "5", "10"]); break;
      case 15: cfg.GameSpeed = cycle(cfg.GameSpeed, ["0", "1", "2", "3", "4", "5", "6"]); break;
      case 16: cfg.AIPlayers = cycle(cfg.AIPlayers, ["0", "1", "2", "3", "4", "5"]); break;
      case 17: cfg.AIDifficulty = cycle(cfg.AIDifficulty, ["0", "1", "2"]); break;
      case 18: cfg.ShortGame = toggle(cfg.ShortGame, "yes", "no"); break;
      case 19: cfg.FogOfWar = toggle(cfg.FogOfWar, "yes", "no"); break;
      case 20: cfg.CarpetNuke = cycle(cfg.CarpetNuke, ["1", "2", "4", "6", "8", "10"]); break;
      case 21: diagnostics(log); break;
      case 22: cfg = resetCfg(); break;
      case 23: cfg.Patches = cycle(cfg.Patches, ["full", "safe", "none"]); break;
      case 24: applyPreset(cfg, cycle(presetKey(cfg), ["player", "all", "vanilla"])); break;
      case 0: running = false; break;
      default:
        log("\u041D\u0435 \u043F\u043E\u043D\u044F\u043B. \u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430.");
    }
    saveCfg(cfg);
  }
}

function swModeLabel(v) {
  var m = lower(v);
  if (m === "all") { return "\u0432\u0441\u0435\u043C (\u0438 \u0431\u043E\u0442\u0443 \u0442\u043E\u0436\u0435)"; }
  if (m === "off") { return "\u043A\u0430\u043A \u0432 \u043E\u0440\u0438\u0433\u0438\u043D\u0430\u043B\u0435"; }
  return "\u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0433\u0440\u043E\u043A\u0443";
}

/* Presets: one keystroke instead of twelve toggles. */
function applyPreset(cfg, key) {
  if (key === "player") {
    cfg.Patches = "full";
    cfg.SandboxSW = "player";
    cfg.SWRecharge = "instant";
    cfg.KitCost = "1500";
    cfg.RevealMap = "yes";
    cfg.BigBoom = "yes";
    cfg.CarpetNuke = "6";
    cfg.BuildSpeed = "normal";
    cfg.Heroes = "normal";
    cfg.BonusBuildings = "normal";
    cfg.SellRefund = "100";
    cfg.FairAI = "yes";
    cfg.Money = "40000";
    cfg.UnitCount = "10";
    cfg.TechLevel = "10";
    cfg.GameSpeed = "1";
    cfg.ShortGame = "no";
    cfg.FogOfWar = "no";
    cfg.AIPlayers = "2";
    cfg.AIDifficulty = "1";
    return;
  }
  if (key === "all") {
    cfg.Patches = "full";
    cfg.SandboxSW = "all";
    cfg.SWRecharge = "instant";
    cfg.RevealMap = "yes";
    cfg.BigBoom = "yes";
    cfg.CarpetNuke = "6";
    cfg.BuildSpeed = "instant";
    cfg.Heroes = "unlimited";
    cfg.BonusBuildings = "unlimited";
    cfg.SellRefund = "100";
    cfg.FairAI = "no";
    return;
  }
  /* vanilla: the mod steps aside completely */
  cfg.Patches = "none";
}

function presetKey(cfg) {
  if (lower(cfg.Patches) === "none") { return "vanilla"; }
  if (lower(cfg.SandboxSW) === "all") { return "all"; }
  return "player";
}

function presetName(cfg) {
  var k = presetKey(cfg);
  if (k === "vanilla") { return "\u0412\u0410\u041D\u0418\u041B\u042C (\u043C\u043E\u0434 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D)"; }
  if (k === "all") { return "\u0425\u0410\u0420\u0414\u041A\u041E\u0420 (\u043F\u043B\u044E\u0448\u043A\u0438 \u0432\u0441\u0435\u043C, \u0432\u043A\u043B\u044E\u0447\u0430\u044F \u0431\u043E\u0442\u0430)"; }
  return "\u041F\u0415\u0421\u041E\u0427\u041D\u0418\u0426\u0410 \u0414\u041B\u042F \u0418\u0413\u0420\u041E\u041A\u0410";
}

function toggle(cur, a, b) { return lower(cur) === a ? b : a; }

function cycle(cur, values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] === String(cur)) { return values[(i + 1) % values.length]; }
  }
  return values[0];
}

function resetCfg() {
  var cfg = {};
  for (var k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { cfg[k] = DEFAULTS[k]; } }
  return cfg;
}

function prompt(log, text) {
  WScript.StdOut.Write(text);
  var s = WScript.StdIn.ReadLine();
  return s === null ? "" : trim(s);
}

function play(cfg, which, log) {
  var gdir = gameDir(cfg);
  var exe = null;
  if (which === "yr") { exe = findExe(gdir, "yr"); }
  else if (which === "ra2") { exe = findExe(gdir, "ra2"); }
  else { exe = findExe(gdir, "auto"); }
  if (exe === null) {
    log("\u041D\u0435 \u043D\u0430\u0448\u0451\u043B exe \u0438\u0433\u0440\u044B \u0432 " + gdir + ".");
    log("\u041F\u043E\u043B\u043E\u0436\u0438\u0442\u0435 \u043F\u0430\u043F\u043A\u0443 SandboxMod \u0432\u043D\u0443\u0442\u0440\u044C \u043F\u0430\u043F\u043A\u0438 \u0438\u0433\u0440\u044B.");
    return false;
  }
  saveCfg(cfg);
  var rc = sandboxSession(cfg, '"' + exe + '"', log);
  return true;
}

/* ---------------------------------------------------------------------- main */

function main() {
  startLog();
  var log = function (s) {
    WScript.Echo(s);
    appendLog(s);
  };
  if (LOG_PATH !== "") { appendLog("game dir: " + gameDir(loadCfg())); }
  var arg = "";
  if (WScript.Arguments.length > 0) { arg = lower(WScript.Arguments(0)); }

  var cfg = loadCfg();

  if (arg === "prepare") {
    var r = prepare(cfg, log);
    return r.ok ? 0 : 1;
  }
  if (arg === "restore") {
    var st = restore(log, false);
    log("\u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E: " + st.restored + ", \u0443\u0434\u0430\u043B\u0435\u043D\u043E: " + st.removed);
    return 0;
  }
  if (arg === "diag") { return diagnostics(log); }
  if (arg === "uninstall") { return uninstall(log); }

  /* Steam mode: the launcher bat passes the full command line in SANDBOX_CMD */
  var cmd = "";
  try { cmd = String(sh.Environment("PROCESS")("SANDBOX_CMD")); } catch (e) { cmd = ""; }
  if (arg === "run" || (cmd !== "" && cmd !== "undefined")) {
    if (cmd === "" || cmd === "undefined") {
      var gdir = gameDir(cfg);
      var exe = findExe(gdir, "auto");
      if (exe === null) { log("\u041D\u0435 \u043D\u0430\u0448\u0451\u043B exe \u0438\u0433\u0440\u044B \u0432 " + gdir); return 1; }
      cmd = '"' + exe + '"';
    }
    return sandboxSession(cfg, cmd, log);
  }

  menu(cfg, log);
  return 0;
}

/* ---------------------------------------------------------------- entry point */

var EXIT_CODE = 0;
try {
  EXIT_CODE = main();
} catch (err) {
  WScript.Echo("");
  WScript.Echo("\u041E\u0428\u0418\u0411\u041A\u0410: " + err.message);
  WScript.Echo("\u0421\u043A\u0440\u0438\u043F\u0442: " + SCRIPT_FILE);
  WScript.Echo("\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 Diagnostics.bat \u0438 \u043F\u043E\u043A\u0430\u0436\u0438\u0442\u0435 \u0432\u044B\u0432\u043E\u0434.");
  EXIT_CODE = 2;
}
WScript.Quit(EXIT_CODE);
