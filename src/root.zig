const Allocator = std.mem.Allocator;
const std = @import("std");

const pcsc = @import("pcsc");
const t = @import("tokota");

const Client = @import("Client.zig");
const Session = @import("Session.zig");

pub const tokota_options = t.Options{
    .lib_name = "pcsc-mini",
    .napi_version = .v8,
};

pub const std_options = std.Options{
    .log_level = .warn,
};

pub const panic = std.debug.FullPanic(t.panicStd);

comptime {
    t.exportModule(@This());
}

const log = std.log.scoped(.@"pcsc-mini");

pub const MAX_ATR_LEN = pcsc.max_atr_len;
pub const MAX_BUFFER_LEN = pcsc.max_buffer_len;
pub const MAX_READERS = Client.max_readers;

/// Helper constants for reader attribute commands.
pub const attributes = struct {
    pub const Class = pcsc.attributes.Class;
    pub const ids = pcsc.attributes.ids;
};

pub const CardDisposition = pcsc.Card.Disposition;

pub const CardMode = pcsc.Card.Mode;

pub const CardStatus = t.enums.FromBitFlags(pcsc.Card.Status, .{});

pub const Protocol = pcsc.Protocol;

pub const ReaderStatus = t.enums.FromBitFlags(pcsc.Reader.Status, .{});

/// Human-readable tag names of the enabled flags in the given status value.
pub fn cardStatusString(status: pcsc.Card.Status) ![]const u8 {
    var buf: [192]u8 = undefined;
    return std.fmt.bufPrint(&buf, "{f}", .{status});
}

/// Platform-specific reader control code.
pub fn controlCode(function_code: u32) u32 {
    return pcsc.controlCode(function_code);
}

/// Main JS entry point - creates a PCSC client interface, bound to a newly
/// allocated `Client` instance.
pub fn newClient(call: t.Call) !Client.Api {
    const allo = std.heap.smp_allocator;

    const client = Client.init(allo) catch |err| return call.env.throwErrCode(
        err,
        "[pcsc-mini] Initialization failed.",
    );

    return .init(client, .with(Client.deinit));
}

/// Human-readable tag name for the given protocol value.
pub fn protocolString(protocol: pcsc.Protocol) ![]const u8 {
    var buf: [16]u8 = undefined;
    return std.fmt.bufPrint(&buf, "{f}", .{protocol});
}

/// Human-readable tag names of the enabled flags in the given status value.
pub fn readerStatusString(status_: pcsc.Reader.Status) ![]const u8 {
    var status = status_;
    status.CHANGED = false; // Not useful to log in this context.

    var buf: [192]u8 = undefined;
    return std.fmt.bufPrint(&buf, "{f}", .{status});
}

test {
    std.testing.refAllDeclsRecursive(@This());
}
