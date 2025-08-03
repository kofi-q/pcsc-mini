const base = @import("base");
const std = @import("std");
const tokota = @import("tokota");

pub fn build(b: *std.Build) !void {
    const mode = b.standardOptimizeOption(.{});
    const target = b.standardTargetOptions(.{});

    const steps = Steps{
        .build_js = b.step("js", "Build JS lib"),
        .check = b.step("check", "Get compile-time diagnostics"),
        .ci = b.step("ci", "Run main CI steps"),
        .client_check = b.step("client:check", "Typecheck the test client"),
        .client_deps = b.step("client:deps", "Install deps for test client"),
        .deps = b.step("deps", "Install JS dependencies"),
        .docs = b.step("docs", "Generate documentation"),
        .e2e = b.step("e2e", "Generate NPM packages and run the test client "),
        .fmt = b.step("fmt", "Format/lint source files"),
        .packages = b.step("packages", "Build all NPM packages"),
        .publish = b.step("publish", "Publish all NPM packages"),
        .test_node = b.step("test:node", "Run NodeJS unit tests"),
        .test_zig = b.step("test:zig", "Run Zig unit tests"),
        .tests = b.step("test", "Run unit tests"),
    };

    const packages = tokota.npm.createPackages(b, .{
        .configureLib = configureLib,
        .mode = .ReleaseSmall,
        .npmignore = b.path(".npmignore"),
        .npmrc = b.path(".npmrc.publish"),
        .output_dir = "npm_packages",
        .package_json = b.path("package.json"),
        .pre_package = steps.build_js,
        .root_source_file = b.path("src/root.zig"),
        .root_typings_file = b.path("lib/addon.node.d.ts"),
        .strip = .{ .val = true },
        .scoped_bin_packages = true,
        .targets = &.{
            .{ .os_tag = .linux, .cpu_arch = .aarch64, .abi = .gnu },
            .{ .os_tag = .linux, .cpu_arch = .aarch64, .abi = .musl },
            .{ .os_tag = .linux, .cpu_arch = .x86_64, .abi = .gnu },
            .{ .os_tag = .linux, .cpu_arch = .x86_64, .abi = .musl },
            .{ .os_tag = .linux, .cpu_arch = .x86, .abi = .gnu },
            .{ .os_tag = .linux, .cpu_arch = .x86, .abi = .musl },
            .{ .os_tag = .macos, .cpu_arch = .aarch64 },
            .{ .os_tag = .macos, .cpu_arch = .x86_64 },
            .{ .os_tag = .windows, .cpu_arch = .aarch64 },
            .{ .os_tag = .windows, .cpu_arch = .x86_64 },
        },
    });

    const addon_dev = createAddon(b, mode, target, .{ .custom = "../lib" });
    b.getInstallStep().dependOn(&addon_dev.install.step);

    const addon_stub = createAddon(b, mode, target, .prefix);
    tokota.Addon.linkNodeStub(b, addon_stub.lib, null);

    addDocs(b, &steps, &addon_stub);
    addClientDeps(b, &steps);
    addClientRun(b, &steps);
    addClientTypecheck(b, &steps);
    addFmt(b, &steps);
    addJsBuild(b, &steps);
    addJsDeps(b, &steps);
    addJsTests(b, &steps, &addon_dev);
    addZigTests(b, &steps, &addon_stub);

    steps.check.dependOn(&b.addLibrary(.{
        .name = "check",
        .root_module = addon_dev.root_module,
    }).step);

    steps.packages.dependOn(packages.install);
    steps.publish.dependOn(packages.publish);

    steps.tests.dependOn(steps.test_node);
    steps.tests.dependOn(steps.test_zig);

    steps.ci.dependOn(steps.client_check);
    steps.ci.dependOn(steps.fmt);
    steps.ci.dependOn(steps.packages);
    steps.ci.dependOn(steps.tests);
}

fn createAddon(
    b: *std.Build,
    mode: std.builtin.OptimizeMode,
    target: std.Build.ResolvedTarget,
    output_dir: std.Build.InstallDir,
) tokota.Addon {
    const addon = tokota.Addon.create(b, .{
        .mode = mode,
        .output_dir = output_dir,
        .root_source_file = b.path("src/root.zig"),
        .target = target,
    });

    configureLib(b, addon.lib);

    return addon;
}

fn addClientTypecheck(b: *std.Build, steps: *const Steps) void {
    const run = b.addSystemCommand(&.{ "pnpm", "tsc", "-p" });
    run.addFileArg(b.path("e2e/tsconfig.json"));
    run.step.dependOn(steps.client_deps);
    steps.client_check.dependOn(&run.step);
}

fn addClientDeps(b: *std.Build, steps: *const Steps) void {
    const clean = b.addRemoveDirTree(b.path("e2e/node_modules"));
    const copy_package_main = b.addInstallDirectory(.{
        .install_dir = .{ .custom = "../e2e/node_modules" },
        .install_subdir = "pcsc-mini",
        .source_dir = b.path("zig-out/npm_packages/pcsc-mini"),
    });
    copy_package_main.step.dependOn(steps.packages);
    copy_package_main.step.dependOn(&clean.step);

    const copy_package_bins = b.addInstallDirectory(.{
        .install_dir = .{ .custom = "../e2e/node_modules/pcsc-mini" },
        .install_subdir = "node_modules/@pcsc-mini",
        .source_dir = b.path("zig-out/npm_packages/@pcsc-mini"),
    });
    copy_package_bins.step.dependOn(&copy_package_main.step);
    steps.client_deps.dependOn(&copy_package_bins.step);
}

fn addClientRun(b: *std.Build, steps: *const Steps) void {
    const run = b.addSystemCommand(&.{"node"});
    run.addFileArg(b.path("e2e/index.js"));
    run.setCwd(b.path("e2e"));
    run.step.dependOn(steps.client_deps);
    steps.e2e.dependOn(&run.step);
}

fn addDocs(
    b: *std.Build,
    steps: *const Steps,
    addon_dev: *const tokota.Addon,
) void {
    const lib = b.addLibrary(.{
        .name = "pcsc-mini",
        .root_module = addon_dev.root_module,
    });
    tokota.Addon.linkNodeStub(b, lib, null);

    const docs_zig = base.addDocs(b, lib, .{
        .html_logo = "pcsc-mini",
        .install_dir = .{ .custom = "../docs" },
        .install_subdir = "zig",
        .repo_url = "https://github.com/kofi-q/pcsc-mini",
    });

    const docs_ts = b.addSystemCommand(&.{
        "pnpm",                  "typedoc",
        "--name",                "pcsc-mini",
        "--customCss",           "website/styles.css",
        "--plugin",              "typedoc-github-theme",
        "--lightHighlightTheme", "min-light",
        "--darkHighlightTheme",  "min-dark",
        "--router",              "kind-dir",
        "--includeVersion",      "lib",
    });
    docs_ts.step.dependOn(steps.deps);
    docs_zig.step.dependOn(&docs_ts.step);

    steps.docs.dependOn(&docs_ts.step);
    steps.docs.dependOn(&docs_zig.step);
}

fn addFmt(b: *std.Build, steps: *const Steps) void {
    const prettier = b.addSystemCommand(&.{ "pnpm", "prettier" });
    prettier.addArg(if (isCi()) "--check" else "--write");
    prettier.addArgs(&.{ "e2e", "lib" });
    prettier.step.dependOn(steps.deps);

    const eslint = b.addSystemCommand(&.{ "pnpm", "eslint" });
    if (!isCi()) eslint.addArg("--fix");
    eslint.addArg("lib");
    eslint.step.dependOn(&prettier.step);
    eslint.step.dependOn(steps.deps);

    const zig_fmt = b.addFmt(.{
        .check = isCi(),
        .paths = &.{ "build.zig", "src" },
    });

    steps.fmt.dependOn(&zig_fmt.step);
    steps.fmt.dependOn(&eslint.step);
    steps.fmt.dependOn(&prettier.step);
}

fn addJsBuild(b: *std.Build, steps: *const Steps) void {
    const run = b.addSystemCommand(&.{ "pnpm", "tsc" });
    run.step.dependOn(steps.deps);
    steps.build_js.dependOn(&run.step);
    b.getInstallStep().dependOn(steps.build_js);
}

fn addJsDeps(b: *std.Build, steps: *const Steps) void {
    const install_deps_js = b.addSystemCommand(&.{
        "pnpm", "i", "--frozen-lockfile",
    });
    steps.deps.dependOn(&install_deps_js.step);
}

fn addJsTests(
    b: *std.Build,
    steps: *const Steps,
    addon_dev: *const tokota.Addon,
) void {
    const node_test = b.addSystemCommand(&.{
        "node", "--test", "--import=tsx",
    });
    if (b.args) |args| for (args) |arg| {
        if (std.mem.eql(u8, arg, "--watch")) {
            node_test.addArg("--watch");
        }
    };
    node_test.setCwd(b.path("lib"));
    node_test.step.dependOn(&addon_dev.install.step);
    node_test.step.dependOn(steps.deps);
    steps.test_node.dependOn(&node_test.step);
}

fn addZigTests(
    b: *std.Build,
    steps: *const Steps,
    addon_stub: *const tokota.Addon,
) void {
    const lib_tests = b.addTest(.{ .root_module = addon_stub.root_module });
    tokota.Addon.linkNodeStub(b, lib_tests, null);
    lib_tests.use_llvm = true; // x86 backend may be unstable at the moment.

    steps.test_zig.dependOn(&b.addRunArtifact(lib_tests).step);
}

fn configureLib(b: *std.Build, lib: *std.Build.Step.Compile) void {
    const mode = lib.root_module.optimize.?;
    const target = lib.root_module.resolved_target.?;

    lib.root_module.addImport("base", b.dependency("base", .{
        .optimize = mode,
        .target = target,
    }).module("base"));

    lib.root_module.addImport("pcsc", b.dependency("pcsc", .{
        .optimize = mode,
        .target = target,
    }).module("pcsc"));

    lib.use_llvm = true; // x86 backend may be unstable at the moment.
}

fn isCi() bool {
    return std.process.hasNonEmptyEnvVarConstant("CI");
}

const Steps = struct {
    build_js: *std.Build.Step,
    check: *std.Build.Step,
    ci: *std.Build.Step,
    e2e: *std.Build.Step,
    client_check: *std.Build.Step,
    client_deps: *std.Build.Step,
    deps: *std.Build.Step,
    docs: *std.Build.Step,
    fmt: *std.Build.Step,
    packages: *std.Build.Step,
    publish: *std.Build.Step,
    test_node: *std.Build.Step,
    test_zig: *std.Build.Step,
    tests: *std.Build.Step,
};
