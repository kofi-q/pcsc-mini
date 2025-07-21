const std = @import("std");

const base = @import("base");
const pcsc = @import("pcsc");
const t = @import("tokota");

const Atr = base.BoundedArray(u8, pcsc.max_atr_len);
const CardMode = pcsc.Card.Mode;
const Protocol = pcsc.Protocol;
const Reader = pcsc.ReaderT(*ReaderName);
const ReaderName = base.BoundedArray(u8, pcsc.max_reader_name_len);
const Session = @import("Session.zig");

/// Maximum number of readers that will be actively tracked in the
/// monitoring thread. Open to future adjustment.
pub const max_readers = 4;

/// Maximum number of reader state change queries sent in a batch, which is the
/// max number of supported readers + 1 slot for general reader detection query.
const max_queries = max_readers + 1;

const log = std.log.scoped(.@"pcsc-mini:client");

const Client = @This();

allo: std.mem.Allocator,

/// Connection to the PCSC server.
client: ?pcsc.Client = null,

/// The reader state background monitoring thread. See `mainLoop`.
monitoring_thread: ?std.Thread = null,

/// Error messaging channel to the main JS thread.
on_err: ?t.threadsafe.Fn(*Err) = null,

/// Reader status messaging channel to the main JS thread.
on_change: ?t.threadsafe.Fn(*ReaderEvent) = null,

/// Pool of reader status change event objects.
pool_events: [max_readers]ReaderEvent = @splat(.empty),

/// Card connection session pool.
pool_sessions: [max_readers]Session = @splat(.empty),

/// Card connection task pool.
pool_tasks: [max_readers]TaskConnect = @splat(.empty),

/// Reader name pool. Each is assigned to a reader in the range
/// `readers[1..][0..max_readers]`.
reader_names: [max_readers]ReaderName = @splat(.initEmpty()),

/// Reader state object pool. Capped at `max_readers`, with an
/// additional slot for the background reader detection query.
readers: [1 + max_readers]Reader = [_]Reader{.pnp_query} ++ readers_empty,

const readers_empty: [max_readers]Reader = @splat(.empty);

/// Allocates a new PCSC client.
///
/// No connection is made until `start()` is called.
pub fn init(allo: std.mem.Allocator) !*Client {
    const client = try allo.create(Client);
    client.* = .{ .allo = allo };

    for (client.readers[1..], &client.reader_names) |*reader, *name| {
        reader.status = .{ .flags = .{ .IGNORE = true } };
        reader.user_data = name;
        reader.name_ptr = name.constSliceZ().ptr;
    }

    return client;
}

/// Deallocates and closes the PCSC client context,
/// rendering this client unusable.
pub fn deinit(self: *Client, _: t.Env) !void {
    try self.stopImpl();
    self.allo.destroy(self);
}

const Call = t.CallT(*Client);

/// The JS-facing API for communicating managing the PCSC client.
pub const Api = t.Api(*Client, struct {
    /// Opens a new client and creates a card connection session.
    /// Asserts a maximum of `max_readers` open at any point
    ///
    /// Runs on the main JS thread.
    pub fn connect(
        call: Call,
        reader_name: t.Val,
        mode: CardMode,
        protocol: ?Protocol,
    ) !t.Promise {
        const self = try fromCall(call);

        const session = ok: for (&self.pool_sessions) |*session| {
            if (session.in_use) continue;
            break :ok session;
        } else {
            return error.TooManyCardConnections;
        };

        const task = ok: for (&self.pool_tasks) |*task| {
            if (task.in_use) continue;
            break :ok task;
        } else {
            return error.TooManyConnectRequests;
        };

        task.* = .{
            .in_use = true,
            .mode = mode,
            .protocol = protocol orelse .ANY,
            .reader_name = .initEmpty(),
            .session = session,
            .task_js = undefined,
        };

        errdefer task.deinit();

        try task.reader_name.resizeToSlice(try reader_name.stringBuf(
            call.env,
            &task.reader_name.buf,
        ));

        session.in_use = true;

        return call.env.asyncTask(task, &task.task_js);
    }

    /// Establishes a connection with the PCSC server and starts monitoring for
    /// reader state changes in a background thread.
    pub fn start(call: Call, on_change: t.Fn, on_err: t.Fn) !void {
        const self = try fromCall(call);

        log.debug("Start requested. Initializing monitoring loop...", .{});

        if (self.monitoring_thread) |_| return call.env.throwErrCode(
            error.ClientAlreadyStarted,
            "PCSC client is already monitoring for reader/card updates.",
        );

        self.client = try pcsc.Client.init(.SYSTEM);

        self.on_err = try on_err.threadsafeFn({}, *Err, emitErr, .{});
        errdefer self.on_err.?.release(.abort) catch |err| log.warn(
            "Unable to release thread-safe fn for client error callback: {}\n",
            .{err},
        );

        self.on_change = try on_change.threadsafeFn(
            {},
            *ReaderEvent,
            emitStatus,
            .{ .max_queue_size = max_readers },
        );
        errdefer self.on_change.?.release(.abort) catch |err| log.warn(
            "Unable to release thread-safe fn for reader status callback: {}\n",
            .{err},
        );

        self.monitoring_thread = try std.Thread.spawn(.{}, mainLoop, .{self});

        log.debug("Client connection established. Monitoring...", .{});
    }

    /// Closes the connection to the PCSC server and
    /// shuts down the background monitoring thread.
    pub fn stop(call: Call) !void {
        log.debug("Stop requested.", .{});

        const self = try fromCall(call);
        try self.stopImpl();
    }
});

const Err = struct {
    allo: *const std.mem.Allocator,
    code: anyerror,
    msg: []const u8,

    fn deinit(self: *Err) void {
        const allo = self.allo;
        allo.destroy(self);
    }
};

fn clearReader(reader: *Reader) void {
    reader.status = .{ .flags = .{ .IGNORE = true } };
    reader.status_new = .UNAWARE;
    reader.user_data.?.clear();
}

fn compactReaders(self: *Client) []Reader {
    var count: u8 = 1;
    for (1..self.readers.len) |i| {
        const src = &self.readers[i];

        if (src.status.flags.IGNORE) continue;
        defer count += 1;

        if (i == count) continue;

        const dest = &self.readers[count];
        dest.status = src.status;
        dest.status_new = .UNAWARE;
        dest.user_data.?.copyFrom(readerName(src)) catch unreachable;

        clearReader(src);
    }

    return self.readers[0..count];
}

/// Calls the JS error event listener with the given error.
fn emitErr(env: t.Env, err: *Err, cb: t.Fn) !void {
    defer err.deinit();
    _ = try cb.call(env.err(err.msg, err.code));
}

/// Calls the JS state change listener with the given reader info.
fn emitStatus(env: t.Env, reader: *ReaderEvent, cb: t.Fn) !void {
    defer reader.deinit();

    _ = try cb.call(.{
        reader.name.constSlice(),
        reader.status,
        try env.typedArrayFrom(reader.atr.constSlice()),
    });
}

/// Extracts the corresponding `Client` instance from the incoming JS call.
fn fromCall(call: Call) !*Client {
    return try call.data() orelse call.env.throwErrType(.{
        .msg = "Invalid client",
    });
}

/// Listens for reader state changes (connect/disconnect, card inserted/removed,
/// etc). Calls the stored change/error event listener thread-safe fns with the
/// relevant data when detected.
fn mainLoop(self: *Client) void {
    defer {
        self.on_change.?.release(.release) catch |err| log.warn(
            "Unable to release thread-safe fn for reader status callback: {t}\n",
            .{err},
        );

        self.on_err.?.release(.release) catch |err| log.warn(
            "Unable to release thread-safe fn for client error callback: {t}\n",
            .{err},
        );
    }

    while (self.tick()) {} else |err| switch (err) {
        t.Err.ThreadsafeFnClosing => log.debug("Node process exiting...", .{}),

        pcsc.Err.Cancelled => log.debug("Monitoring loop stopped.", .{}),

        pcsc.Err.Shutdown,
        pcsc.Err.SystemCancelled,
        => self.sendErr(err, "PCSC server shut down unexpectedly."),

        else => self.sendErr(err, "Reader monitoring loop failed."),
    }
}

inline fn readerName(reader: *const Reader) []const u8 {
    return reader.user_data.?.constSlice();
}

/// Helper for reporting errors to the error listener thread-safe fn.
fn sendErr(self: *const Client, code: anyerror, comptime msg: []const u8) void {
    const event = self.allo.create(Err) catch t.panic("OOM", null);
    event.* = .{ .allo = &self.allo, .code = code, .msg = msg };

    self.on_err.?.call(event, .non_blocking) catch |err| switch (err) {
        t.Err.ThreadsafeFnClosing => {},
        else => log.err(
            \\Unable to emit error event: {[reason]t}
            \\  Original error code: {[code]t}
            \\  Original error message: {[msg]s}
        , .{
            .reason = err,
            .code = code,
            .msg = msg,
        }),
    };
}

/// Closes the connection to the PCSC server and
/// shuts down the background monitoring thread.
fn stopImpl(self: *Client) !void {
    const client = self.client orelse return;

    log.debug("Shutting down monitoring loop...", .{});

    try client.deinit();

    self.monitoring_thread.?.join();
    self.monitoring_thread = null;

    self.on_change = null;
    self.on_err = null;
    self.client = null;
}

/// Executes a single iteration in the background monitoring thread - checks for
/// detected readers and sleeps until the states of any of those readers change.
fn tick(self: *Client) !void {
    const client = self.client orelse return pcsc.Err.Cancelled;

    var reader_names = try client.readerNames();

    var idx_next_slot: u8 = 1;
    while (idx_next_slot < max_queries) {
        const name = reader_names.next() orelse break;
        var is_existing = false;

        for (self.readers[1..]) |*r| if (std.mem.eql(u8, name, readerName(r))) {
            // Just in case this reader has blipped back into existence
            // in the time since we last saw it disappear.
            r.status.flags.IGNORE = false;
            is_existing = true;
            break;
        };

        if (is_existing) continue;

        const idx_start = idx_next_slot;
        for (self.readers[idx_start..max_queries]) |*reader| {
            idx_next_slot += 1;

            const is_empty_slot = reader.status.flags.IGNORE;
            if (!is_empty_slot) continue;

            // [ASSERT]: Names are never longer than `pcsc.max_reader_name_len`.
            reader.user_data.?.copyFrom(name) catch unreachable;

            reader.status = .UNAWARE;
            reader.status_new = .UNAWARE;

            break;
        }
    }

    const queries = self.compactReaders();
    try client.waitForUpdates(queries, .infinite);

    for (queries) |*reader| {
        reader.status = reader.status_new;

        if (reader.name_ptr == Reader.pnp_query_name) continue;

        defer if (reader.status_new.flags.hasAny(.{
            .UNAVAILABLE = true,
            .UNKNOWN = true,
        })) {
            clearReader(reader);
        };

        if (!reader.status_new.flags.CHANGED) continue;

        for (&self.pool_events) |*event| {
            if (event.in_use.load(.acquire)) continue;

            event.init(reader);
            try self.on_change.?.call(event, .non_blocking);
            break;
        } else return self.sendErr(
            error.StatusEventBufferOverflow,
            "Out of space while queuing reader status change event.",
        );
    }
}

const ReaderEvent = struct {
    atr: Atr,
    in_use: std.atomic.Value(bool),
    name: ReaderName,
    status: Reader.Status,

    const empty = ReaderEvent{
        .atr = .initEmpty(),
        .in_use = .init(false),
        .name = .initEmpty(),
        .status = .{},
    };

    fn init(self: *ReaderEvent, reader: *Reader) void {
        self.name.copyFrom(readerName(reader)) catch unreachable;
        self.atr.copyFrom(reader.atr()) catch unreachable;
        self.status = reader.status.flags;
        self.in_use.store(true, .release);
    }

    fn deinit(self: *ReaderEvent) void {
        self.in_use.store(false, .monotonic);
    }
};

/// Async task for connecting to an inserted card. Triggered by a JS call to
/// `Client.Api.connect`. IF successful, a new `Session` is created and bound to
/// a JS interface object.
const TaskConnect = struct {
    in_use: bool,
    mode: CardMode,
    protocol: Protocol,
    reader_name: ReaderName,
    session: *Session,
    task_js: t.Async.Task(*@This()),

    const empty = TaskConnect{
        .in_use = false,
        .mode = undefined,
        .task_js = undefined,
        .protocol = undefined,
        .reader_name = .initEmpty(),
        .session = undefined,
    };

    pub fn deinit(self: *TaskConnect) void {
        self.in_use = false;
    }

    pub fn execute(self: *TaskConnect) !void {
        self.session.client = try pcsc.Client.init(.SYSTEM);

        self.session.card = self.session.client.?.connect(
            self.reader_name.constSliceZ().ptr,
            self.mode,
            self.protocol,
        ) catch |err| {
            try self.session.client.?.deinit();
            self.session.deinit();
            return err;
        };
    }

    pub fn complete(self: *TaskConnect, _: t.Env) !Session.Api {
        log.debug("[{f}] Card connected with protocol {f}", .{
            self.reader_name,
            self.session.card.?.protocol,
        });

        return .{ .data = self.session };
    }

    pub fn cleanUp(self: *TaskConnect, _: t.Env) void {
        self.deinit();
    }
};
