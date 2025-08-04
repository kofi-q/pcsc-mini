const std = @import("std");

const pcsc = @import("pcsc");
const t = @import("tokota");

const Disposition = pcsc.Card.Disposition;
const CardMode = pcsc.Card.Mode;
const Protocol = pcsc.Protocol;

const log = std.log.scoped(.@"pcsc-mini:card-session");

const Session = @This();

card: ?pcsc.Card,
client: ?pcsc.Client,
in_use: bool,
task: Task,
txn: ?pcsc.Card.Transaction,

/// A slot for card session tasks, of which only one can be active at a time.
/// Each task contains an `in_use: bool` field which is read/written on the main
/// JS thread, removing the need for additional locking/atomics.
const Task = union(enum) {
    attribute_get: TaskAttributeGet,
    attribute_set: TaskAttributeSet,
    control: TaskControl,
    disconnect: TaskDisconnect,
    idle: TaskIdle,
    reconnect: TaskReconnect,
    state: TaskState,
    transmit: TaskTransmit,
    txn_begin: TaskTxnBegin,
    txn_end: TaskTxnEnd,

    fn inUse(self: Task) bool {
        return switch (self) {
            inline else => |task| task.in_use,
        };
    }
};

pub const empty = Session{
    .card = null,
    .client = null,
    .in_use = false,
    .task = .{ .idle = .{} },
    .txn = null,
};

pub fn deinit(self: *Session) void {
    self.client = null;
    self.card = null;
    self.txn = null;

    self.in_use = false;
}

const Call = t.CallT(*Session);

/// JS-facing API for an active card connection session.
pub const Api = t.Api(*Session, struct {
    /// Requests a given reader attribute and
    /// writes the response to the given buffer.
    pub fn attributeGet(
        call: Call,
        id: pcsc.attributes.Id,
        buf_out: ?t.ArrayBuffer,
    ) !t.Promise {
        const self = try fromCall(call);
        try self.assertCardReady(call.env);

        const buffer = buf_out orelse try call.env.arrayBuffer(
            pcsc.max_buffer_len,
        );

        self.task = .{ .attribute_get = .{
            .buf_out = buffer.data,
            .buf_out_ref = try buffer.ref(1),
            .id = id,
            .in_use = true,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.attribute_get.deinit();

        return call.env.asyncTask(
            &self.task.attribute_get,
            &self.task.attribute_get.task_js,
        );
    }

    /// Sets the given reader attribute.
    pub fn attributeSet(
        call: Call,
        id: pcsc.attributes.Id,
        value: t.TypedArray(.u8),
    ) !t.Promise {
        const self = try fromCall(call);
        try self.assertCardReady(call.env);

        self.task = .{ .attribute_set = .{
            .id = id,
            .in_use = true,
            .session = self,
            .task_js = undefined,
            .value = value.data,
        } };

        errdefer self.task.attribute_set.deinit();

        return call.env.asyncTask(
            &self.task.attribute_set,
            &self.task.attribute_set.task_js,
        );
    }

    /// Sends a control command to the reader and writes the response to the
    /// given buffer.
    pub fn control(
        call: Call,
        code: u32,
        cmd: ?t.TypedArray(.u8),
        buf_out: ?t.ArrayBuffer,
    ) !t.Promise {
        const self = try fromCall(call);
        try self.assertCardReady(call.env);

        const buffer = buf_out orelse try call.env.arrayBuffer(
            pcsc.max_buffer_len,
        );

        self.task = .{ .control = .{
            .buf_out = buffer.data,
            .buf_out_ref = try buffer.ref(1),
            .code = code,
            .cmd = if (cmd) |i| i.data else null,
            .in_use = true,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.control.deinit();

        return call.env.asyncTask(
            &self.task.control,
            &self.task.control.task_js,
        );
    }

    /// Disconnects from the card, rendering this `Session` invalid.
    pub fn disconnect(call: Call, disposition: Disposition) !t.Promise {
        const self = try fromCall(call);

        // No-op if there's no card connection.
        if (self.card == null) return call.env.promiseResolve({});

        try self.assertCardReady(call.env);
        self.task = .{ .disconnect = .{
            .disposition = disposition,
            .in_use = true,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.disconnect.deinit();

        return call.env.asyncTask(
            &self.task.disconnect,
            &self.task.disconnect.task_js,
        );
    }

    /// The currently active card communication protocol.
    pub fn protocol(call: Call) !Protocol {
        const self = try fromCall(call);
        return if (self.card) |card| card.protocol else .UNSET;
    }

    /// Attempts to reconnect to a card after a reset by another process.
    pub fn reconnect(
        call: Call,
        mode: CardMode,
        disposition: Disposition,
    ) !t.Promise {
        const self = try fromCall(call);

        try self.assertCardReady(call.env);

        self.task = .{ .reconnect = .{
            .disposition = disposition,
            .in_use = true,
            .mode = mode,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.reconnect.deinit();

        return call.env.asyncTask(
            &self.task.reconnect,
            &self.task.reconnect.task_js,
        );
    }

    /// Returns the current state of the inserted card.
    pub fn state(call: Call) !t.Promise {
        const self = try fromCall(call);

        try self.assertCardReady(call.env);

        self.task = .{ .state = .{
            .in_use = true,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.state.deinit();

        return call.env.asyncTask(&self.task.state, &self.task.state.task_js);
    }

    /// Opens a transaction, essentially creating a temporary exclusive card
    /// connection session, regardless of the initial connection mode.
    ///
    /// Resolves with a transaction handle with a single `end()` method, a call
    /// to which will end the transaction and restore the original card
    /// connection mode.
    pub fn transaction(call: Call) !t.Promise {
        const self = try fromCall(call);

        try self.assertCardReady(call.env);

        self.task = .{ .txn_begin = .{
            .in_use = true,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.txn_begin.deinit();

        return call.env.asyncTask(
            &self.task.txn_begin,
            &self.task.txn_begin.task_js,
        );
    }

    /// Transmits data to the card and writes the response to the given buffer.
    ///
    /// If a protocol is not specific, uses the same protocol negotiated when
    /// the card connection was established/re-established.
    pub fn transmit(
        call: Call,
        proto: ?Protocol,
        input: t.TypedArray(.u8),
        buf_out: ?t.ArrayBuffer,
    ) !t.Promise {
        const self = try fromCall(call);
        try self.assertCardReady(call.env);

        const buffer = buf_out orelse try call.env.arrayBuffer(
            pcsc.max_buffer_len,
        );

        self.task = .{ .transmit = .{
            .buf_out = buffer.data,
            .buf_out_ref = try buffer.ref(1),
            .data = input.data,
            .in_use = true,
            .protocol = proto orelse self.card.?.protocol,
            .session = self,
            .task_js = undefined,
        } };

        errdefer self.task.transmit.deinit();

        return call.env.asyncTask(
            &self.task.transmit,
            &self.task.transmit.task_js,
        );
    }
});

fn assertCardReady(self: *const Session, env: t.Env) !void {
    if (self.task.inUse()) return env.throwErrCode(
        error.CardIsBusy,
        "Another operation is currently in progress.",
    );

    if (self.card == null) return env.throwErrCode(
        error.NoCardConnection,
        "Card connection is no longer active.",
    );
}

fn fromCall(call: Call) !*Session {
    return try call.data() orelse call.env.throwErrType(.{
        .msg = "Invalid card session",
    });
}

const TaskAttributeGet = struct {
    buf_out: []u8,
    buf_out_ref: t.Ref(t.ArrayBuffer),
    id: pcsc.AttrId,
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskAttributeGet) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskAttributeGet) !usize {
        const card = self.session.card orelse return error.NoCardConnection;
        const res = try card.attribute(self.id, self.buf_out);

        return res.len;
    }

    pub fn complete(
        self: *const TaskAttributeGet,
        env: t.Env,
        response_len: usize,
    ) !t.TypedArray(.u8) {
        const buf = try self.buf_out_ref.val(env);
        return buf.?.typedArray(.u8, 0, response_len);
    }

    pub fn cleanUp(self: *TaskAttributeGet, _: t.Env) void {
        self.deinit();
    }
};

const TaskAttributeSet = struct {
    id: pcsc.AttrId,
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),
    value: []const u8,

    pub fn deinit(self: *TaskAttributeSet) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskAttributeSet) !void {
        const card = self.session.card orelse return error.NoCardConnection;
        try card.attributeSet(self.id, self.value);
    }

    pub fn cleanUp(self: *TaskAttributeSet, _: t.Env) void {
        self.deinit();
    }
};

const TaskControl = struct {
    buf_out: []u8,
    buf_out_ref: t.Ref(t.ArrayBuffer),
    code: u32,
    cmd: ?[]const u8,
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskControl) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskControl) !usize {
        const card = self.session.card orelse return error.NoCardConnection;
        const res = try card.control(self.code, self.cmd, self.buf_out);

        return res.len;
    }

    pub fn complete(
        self: *const TaskControl,
        env: t.Env,
        response_len: usize,
    ) !t.TypedArray(.u8) {
        const buf = try self.buf_out_ref.val(env);
        return buf.?.typedArray(.u8, 0, response_len);
    }

    pub fn cleanUp(self: *TaskControl, _: t.Env) void {
        self.deinit();
    }
};

const TaskDisconnect = struct {
    disposition: Disposition,
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskDisconnect) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskDisconnect) !void {
        try self.session.card.?.disconnect(self.disposition);
        try self.session.client.?.deinit();
    }

    pub fn complete(self: *const TaskDisconnect, _: t.Env) !void {
        self.session.deinit();
    }

    pub fn cleanUp(self: *TaskDisconnect, _: t.Env) void {
        self.deinit();
    }
};

/// Placeholder initial task, for when no other tasks are in progress.
const TaskIdle = struct { in_use: bool = false };

const TaskReconnect = struct {
    disposition: Disposition,
    in_use: bool,
    mode: CardMode,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskReconnect) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskReconnect) !Protocol {
        const card = &(self.session.card orelse return error.NoCardConnection);
        try card.reconnect(self.mode, self.disposition);

        return card.protocol;
    }

    pub fn cleanUp(self: *TaskReconnect, _: t.Env) void {
        self.deinit();
    }
};

const TaskState = struct {
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),

    const State = pcsc.Card.State;

    pub fn deinit(self: *TaskState) void {
        self.in_use = false;
    }

    pub fn execute(self: *TaskState) !State {
        const card = self.session.card orelse return error.NoCardConnection;
        return card.state();
    }

    pub fn complete(
        _: *const TaskState,
        env: t.Env,
        new_state: State,
    ) !CardStateJs {
        return .{
            .atr = try env.typedArrayFrom(new_state.atr.slice()),
            .protocol = new_state.protocol,
            .readerName = new_state.reader_name.slice(),
            .status = new_state.status,
        };
    }

    pub fn cleanUp(self: *TaskState, _: t.Env) void {
        self.deinit();
    }
};

const CardStateJs = struct {
    atr: t.TypedArray(.u8),
    protocol: Protocol,
    readerName: []const u8,
    status: pcsc.Card.Status,
};

const TaskTransmit = struct {
    buf_out: []u8,
    buf_out_ref: t.Ref(t.ArrayBuffer),
    data: []u8,
    in_use: bool,
    protocol: Protocol,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskTransmit) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskTransmit) !usize {
        const card = self.session.card orelse return error.NoCardConnection;
        const res = try card.transmitProtocol(
            self.protocol,
            self.data,
            self.buf_out,
        );

        return res.len;
    }

    pub fn complete(
        self: *const TaskTransmit,
        env: t.Env,
        response_len: usize,
    ) !t.TypedArray(.u8) {
        const buf = try self.buf_out_ref.val(env);
        return buf.?.typedArray(.u8, 0, response_len);
    }

    pub fn cleanUp(self: *TaskTransmit, _: t.Env) void {
        self.deinit();
    }
};

const TaskTxnBegin = struct {
    in_use: bool,
    task_js: t.async.Task(*@This()),
    session: *Session,

    pub fn deinit(self: *TaskTxnBegin) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskTxnBegin) !void {
        const card = self.session.card orelse return error.NoCardConnection;
        if (self.session.txn) |_| return error.TransactionAlreadyInProgress;

        self.session.txn = try card.transaction();
    }

    pub fn complete(self: *const TaskTxnBegin, _: t.Env) !Txn {
        return .{ .data = self.session };
    }

    pub fn cleanUp(self: *TaskTxnBegin, _: t.Env) void {
        self.deinit();
    }
};

const Txn = t.Api(*Session, struct {
    pub fn end(call: Call, disposition: Disposition) !t.Promise {
        const session = try call.data() orelse return call.env.throwErrType(.{
            .msg = "No transaction reference available.",
        });

        try session.assertCardReady(call.env);

        session.task = .{ .txn_end = .{
            .disposition = disposition,
            .in_use = true,
            .task_js = undefined,
            .session = session,
        } };

        errdefer session.task.txn_end.deinit();

        return call.env.asyncTask(
            &session.task.txn_end,
            &session.task.txn_end.task_js,
        );
    }
});

const TaskTxnEnd = struct {
    disposition: Disposition,
    in_use: bool,
    session: *Session,
    task_js: t.async.Task(*@This()),

    pub fn deinit(self: *TaskTxnEnd) void {
        self.in_use = false;
    }

    pub fn execute(self: *const TaskTxnEnd) !void {
        const txn = self.session.txn orelse return;
        try txn.end(self.disposition);
        self.session.txn = null;
    }

    pub fn cleanUp(self: *TaskTxnEnd, _: t.Env) void {
        self.deinit();
    }
};
