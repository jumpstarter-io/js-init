#!/bin/env node
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var cfg = {
    /// The directory where raw stderr output is stored. We store it in RAM (in tmp)
    /// since storing them in the /app/state directory would expose potentially
    /// internal information to the user. We assume the error log will only be used
    /// for diagnostics and can therfore safely be thrown away.
    "log_dir": "/tmp/log",

    /// We only store the tail of the log and limit it to this size in bytes.
    "log_size": 1000 * 1000,

    /// Daemons should run for at least this many seconds without receiving a
    /// penalty that doubles the backoff interval. If the daemon runs for longer
    /// than this the backoff interval is reset to zero.
    "min_run_s": 60,

    /// Deamons should wait to be restarted with a maximum period of this many
    /// seconds.
    "max_backoff_s": 32
};

// Get context token for init.js logging.
var init_context = path.basename(__filename);

// Indempotently create the log directory.
if (!fs.existsSync(cfg.log_dir))
    fs.mkdirSync(cfg.log_dir, 0750);

// Open log file for daemons.
var log_path = cfg.log_dir + "/init.log";
var log_fd;
var log_size;
var reopen_log_file_fn = function() {
    log_fd = fs.openSync(log_path, "a+", 0640);
    var s = fs.fstatSync(log_fd);
    log_size = s.size;
};
reopen_log_file_fn();

// Rotate log for daemons.
var rotate_log_fn = function() {
    if (log_size > cfg.log_size / 2) {
        // Hot log is too big, replace cold log.
        fs.renameSync(log_path, log_path + ".1");
        // Reopen log file.
        fs.closeSync(log_fd);
        reopen_log_file_fn();
    }
};
rotate_log_fn();

/// Logs one line.
var line_log_fn = function(line, context) {
    var time_str = (new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''));
    var out_line = "[" + time_str + "] [" + context + "] " + line + "\n";
    fs.writeSync(log_fd, out_line);
    process.stderr.write(out_line);
    log_size += out_line.length;
    rotate_log_fn();
};

// Read the daemon configuration.
var raw_daemon_cfg = fs.readFileSync("/app/code/daemons.json", {"encoding": "UTF-8"});
var daemon_cfg = JSON.parse(raw_daemon_cfg);

// Track running daemons.
var daemon_shutdown_fns = {};
var is_shutting_down = false;

// Called when process exits or after daemons exits while shutting down.
var global_exit_fn = function() {
    if (Object.keys(daemon_shutdown_fns).length === 0) {
        line_log_fn("all daemons has shut down, exiting init now", init_context);
        process.exit(0);
    }
    if (!is_shutting_down) {
        line_log_fn("shutting down all running daemons", init_context);
        for (var key in daemon_shutdown_fns)
            daemon_shutdown_fns[key]();
        is_shutting_down = true;
    }
};

// Catch SIGINT/SIGHUP/SIGTERM and redirect to exit_init_fn().
process.on('SIGINT', global_exit_fn);
process.on('SIGHUP', global_exit_fn);
process.on('SIGTERM', global_exit_fn);

// Generate daemon spawners from init proc configuration.
for (var key in daemon_cfg) {
    (function() {
        var first_start = true, pre_exec_done = false;
        var pre_exec_i = 0;
        var daemon_key = key;
        var pre_exec_cfg = daemon_cfg[daemon_key]["pre_exec"];
        var pre_exec_list_cfg = daemon_cfg[daemon_key]["pre_exec_list"];
        var exec_cfg = daemon_cfg[daemon_key]["exec"];
        var exit_signal = daemon_cfg[daemon_key]["exit_signal"];
        var exec_base = path.basename(exec_cfg[0]);
        var backoff_s = 0;
        /// Declare line logger for deamon.
        var daemon_context = ((daemon_key === exec_base)? daemon_key: daemon_key + "/" + exec_base);
        var initd_context = init_context + "/" + daemon_context;
        // Logs one line with default daemon context.
        var dline_log_fn = function(line, context) {
            if (typeof(context) === "undefined")
                context = daemon_context;
            line_log_fn(line, context);
        };
        /// Generates a line reader that reads a stream, splits it up into
        /// lines and calls a callback for each line read. A buffer allows it
        /// to merge lines that are not read atomically from the stream.
        var line_reader_gen = function(line_cb) {
            var tail_buffer = "";
            var flush_timer = null;
            var force_flush_fn = function() {
                if (tail_buffer.length > 0)
                    line_cb(tail_buffer);
                tail_buffer = "";
            };
            var line_reader_fn = function(chunk) {
                if (flush_timer !== null)
                    clearTimeout(flush_timer);
                if (chunk === null) {
                    force_flush_fn();
                    return;
                }
                var lines = chunk.toString().split("\n");
                var tail = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                    var line;
                    if (i === 0) {
                        line = tail_buffer + lines[i];
                        tail_buffer = "";
                    } else {
                        line = lines[i];
                    }
                    line_cb(line);
                }
                tail_buffer += tail;
                if (tail_buffer.length > 1000) {
                    // Line buffer too large, flush it even though it's incomplete.
                    force_flush_fn();
                }
                if (tail_buffer.length > 0) {
                    // Force flush of line buffer if we have not received the rest within 1 second.
                    flush_timer = setTimeout(function() {
                        force_flush_fn();
                        flush_timer = null;
                    }, 1000);
                }
            };
            return line_reader_fn;
        };
        // Generate deaemon spawner.
        var has_pre_exec = (pre_exec_cfg !== undefined);
        var has_pre_exec_list = (pre_exec_list_cfg !== undefined && pre_exec_list_cfg.length > 0);
        if (has_pre_exec && has_pre_exec_list) {
            line_log_fn("syntax error in daemons.json: has both pre_exec and pre_exec_list", init_context);
            process.exit(1);
        }
        var daemon_spawn_fn = function() {
            var run_pre_exec = ((has_pre_exec || has_pre_exec_list) && !pre_exec_done);
            var this_pre_exec_cfg = (has_pre_exec_list? pre_exec_list_cfg[pre_exec_i]: pre_exec_cfg);
            var exec_path = (run_pre_exec? this_pre_exec_cfg: exec_cfg)[0];
            var exec_args = (run_pre_exec? this_pre_exec_cfg: exec_cfg).slice(1);
            // Log (re)start of daemon.
            var lgargs = [];
            for (var i = 0; i < exec_args.length; i++)
                lgargs.push(exec_args[i].replace(/'/g, "\\'"));
            dline_log_fn((first_start? "starting": "restarting") + " "
                + (run_pre_exec? "pre-exec #" + pre_exec_i: "daemon") + ": [" + exec_path
                + (exec_args.length > 0? " '" + lgargs.join("' '") + "'": "") + "]", initd_context);
            // Start daemon.
            var proc = cp.spawn(exec_path, exec_args, {"stdio": ['ignore', 'pipe', 'pipe']});
            var t0 = process.hrtime()[0];
            first_start = false;
            // Update running daemon set of exit functions.
            daemon_shutdown_fns[daemon_key] = function() {
                if (!exit_signal)
                    exit_signal = "SIGTERM";
                dline_log_fn("sending exit signal [" + exit_signal + "]", initd_context);
                proc.kill(exit_signal);
            };
            // Register stdout/stderr handler.
            var stdout_lr_fn = line_reader_gen(dline_log_fn);
            proc.stdout.on('data', stdout_lr_fn);
            var stderr_lr_fn = line_reader_gen(dline_log_fn);
            proc.stderr.on('data', stderr_lr_fn);
            // Register exit event handler.
            proc.on('exit', function(code, signal) {
                // Flush output buffers.
                stdout_lr_fn(null);
                stderr_lr_fn(null);
                // Calculate life time.
                var t1 = process.hrtime()[0];
                var life_s = t1 - t0;
                // Log exit.
                dline_log_fn((run_pre_exec? "pre-exec #" + pre_exec_i: "daemon") + " "
                    + (run_pre_exec || is_shutting_down? "exited": "unexpectedly exited")
                    + " after [" + life_s + " s] with"
                    + (code === null? "": " code [" + code + "]")
                    + (signal === null? "": " signal [" + signal + "]")
                , initd_context);
                // Update running daemons and check global exit.
                delete daemon_shutdown_fns[daemon_key];
                if (is_shutting_down)
                    return global_exit_fn();
                // Restart or start pre-exec/daemon.
                if (run_pre_exec && code === 0) {
                    if (has_pre_exec_list && pre_exec_i < pre_exec_list_cfg.length - 1) {
                        // We ran one of the pre_execs successfully, start the next pre_exec now.
                        dline_log_fn("pre-exec #" + pre_exec_i + " successful, starting next pre-exec", initd_context);
                        pre_exec_i++;
                        first_start = true;
                        daemon_spawn_fn();
                    } else {
                        // We ran pre-exec succesfully, start deamon now.
                        dline_log_fn("pre-exec #" + pre_exec_i + " successful, starting deamon", initd_context);
                        pre_exec_done = true;
                        first_start = true;
                        daemon_spawn_fn();
                    }
                } else {
                    // Generate next backoff based as a function of life time.
                    if (life_s < cfg.min_run_s) {
                        backoff_s = Math.min(backoff_s < 1? 1: backoff_s * 2, cfg.max_backoff_s);
                    } else {
                        backoff_s = 0;
                    }
                    // Determine when we should restart the daemon as a function of life time.
                    setTimeout(function() {
                        daemon_spawn_fn();
                    }, backoff_s * 1000);
                    dline_log_fn("restarting in [" + backoff_s + "] seconds", initd_context);
                }
            });
        };
        daemon_spawn_fn();
    })();
}
