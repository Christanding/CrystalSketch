from __future__ import annotations

import socket
import threading
import time
import webbrowser
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as metadata_version
from typing import TYPE_CHECKING, Annotated

import typer
from rich import box
from rich.console import Console, Group
from rich.panel import Panel
from rich.text import Text

from crystalsketch import __version__

if TYPE_CHECKING:
    from crystalsketch.server.single_instance import InstanceLease

HELP_OPTION_NAMES = ["-h", "--help"]
PACKAGE_NAME = "crystalsketch"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
LOCALHOST_DISPLAY_HOST = "localhost"
LOGO_COLOR = "cyan"
PROMPT_SYMBOL = "›"

HostOption = Annotated[str, typer.Option(help="Host address for the local GUI server.")]
PortOption = Annotated[
    int,
    typer.Option(
        "--port",
        "-p",
        help=(
            "Port for the local GUI server. The default falls back automatically; "
            "use 0 for any free port."
        ),
    ),
]
NoOpenOption = Annotated[
    bool,
    typer.Option("--no-open", help="Do not open the browser automatically."),
]
ReloadOption = Annotated[bool, typer.Option(help="Reload the server when Python files change.")]
VerboseOption = Annotated[
    bool,
    typer.Option("--verbose", help="Show server startup and request logs."),
]


def _current_version() -> str:
    try:
        return metadata_version(PACKAGE_NAME)
    except PackageNotFoundError:
        return __version__


def _print_version(show_version: bool) -> None:
    if show_version:
        typer.echo(f"CrystalSketch {_current_version()}")
        raise typer.Exit()


app = typer.Typer(
    help="Start the CrystalSketch local GUI.",
    context_settings={"help_option_names": HELP_OPTION_NAMES},
    subcommand_metavar="",
)


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            help="Show the installed CrystalSketch version.",
            callback=_print_version,
            is_eager=True,
        ),
    ] = False,
    host: HostOption = DEFAULT_HOST,
    port: PortOption = DEFAULT_PORT,
    no_open: NoOpenOption = False,
    reload: ReloadOption = False,
    verbose: VerboseOption = False,
) -> None:
    """Start the CrystalSketch local GUI."""
    if ctx.invoked_subcommand is None:
        _run_gui(
            host=host,
            port=port,
            no_open=no_open,
            reload=reload,
            verbose=verbose,
            fallback_to_available_port=_parameter_uses_default(ctx, "port"),
        )


def _parameter_uses_default(ctx: typer.Context, name: str) -> bool:
    source = ctx.get_parameter_source(name)
    return getattr(source, "name", None) == "DEFAULT"


def _choose_free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _is_port_available(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
    except OSError:
        return False
    return True


def _choose_port(
    host: str,
    requested_port: int,
    *,
    fallback_to_available_port: bool = False,
) -> int:
    if requested_port == 0:
        return _choose_free_port(host)

    if fallback_to_available_port and not _is_port_available(host, requested_port):
        return _choose_free_port(host)

    return requested_port


def _wait_for_server(host: str, port: int, timeout_seconds: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout_seconds

    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)

    return False


def _open_browser_when_ready(url: str, host: str, port: int) -> None:
    if not _wait_for_server(host, port):
        Console(stderr=True).print(
            "[yellow]Could not start the local server.[/yellow] "
            "Run [bold]Crystal --verbose[/bold] for details."
        )
        return

    try:
        opened = webbrowser.open(url)
    except webbrowser.Error:
        opened = False

    if not opened:
        Console(stderr=True).print(
            "[yellow]Could not open a browser automatically.[/yellow] "
            f"Open [cyan]{url}[/cyan] manually."
        )


def _start_browser_opener(url: str, host: str, port: int) -> None:
    threading.Thread(
        target=_open_browser_when_ready,
        args=(url, host, port),
        daemon=True,
    ).start()


def _uvicorn_log_options(verbose: bool) -> dict[str, object]:
    return {
        "access_log": verbose,
        "log_level": "info" if verbose else "warning",
    }


def _display_url(host: str, port: int) -> str:
    display_host = LOCALHOST_DISPLAY_HOST if host == DEFAULT_HOST else host
    if ":" in display_host:
        display_host = f"[{display_host}]"
    return f"http://{display_host}:{port}/"


def _startup_title() -> Text:
    return Text.assemble(
        "💠 ",
        ("CrystalSketch", f"bold {LOGO_COLOR}"),
        "  ",
        (f"v{_current_version()}", "dim"),
    )


def _startup_server_line(url: str) -> Text:
    return Text.assemble(
        (PROMPT_SYMBOL, "green"),
        "  ",
        ("Local server:", "bold"),
        "  ",
        (url, "cyan"),
    )


def _startup_quit_line() -> Text:
    return Text.assemble(
        (PROMPT_SYMBOL, "green"),
        "  ",
        ("press ", "dim"),
        ("ctrl + c", "bold"),
        (" to quit", "dim"),
    )


def _print_startup_banner(url: str) -> None:
    console = Console()
    console.print(
        Panel.fit(
            Group(
                _startup_title(),
                Text(),
                _startup_server_line(url),
                _startup_quit_line(),
            ),
            box=box.ROUNDED,
            border_style="dim",
            padding=(0, 1),
        ),
        highlight=False,
    )


def _load_uvicorn_run():
    from uvicorn import Config, Server, run

    def run_with_lifecycle(application, **kwargs):
        from crystalsketch.server.update_worker import UpdateError
        from crystalsketch.server.updater import UpdateManager

        manager = getattr(getattr(application, "state", None), "update_manager", None)
        if manager is None:
            occupancy = UpdateManager()
            occupancy.register_runtime()
            try:
                return run(application, **kwargs)
            finally:
                occupancy.service_exited()

        server = Server(Config(application, **kwargs))
        try:
            manager.bind_lifecycle(
                kwargs["host"], kwargs["port"], lambda: setattr(server, "should_exit", True)
            )
        except UpdateError as exc:
            Console(stderr=True).print(
                "[yellow]CrystalSketch is being updated. Wait for it to restart.[/yellow]"
            )
            raise typer.Exit(code=1) from exc
        try:
            return server.run()
        finally:
            manager.service_exited()

    return run_with_lifecycle


def _run_uvicorn(*args: object, **kwargs: object) -> None:
    uvicorn_run = _load_uvicorn_run()
    try:
        uvicorn_run(*args, **kwargs)
    except KeyboardInterrupt:
        pass


def _run_gui(
    host: str,
    port: int,
    no_open: bool,
    reload: bool,
    verbose: bool,
    fallback_to_available_port: bool,
) -> None:
    from crystalsketch.server.single_instance import InstanceError, InstanceInfo, claim_or_reuse
    from crystalsketch.server.update_worker import UpdateError
    from crystalsketch.server.updater import _runtime_tool_root, application_cache

    root = _runtime_tool_root()
    lease: InstanceLease | None = None
    if root is not None:
        try:
            instance = claim_or_reuse(application_cache(), root)
        except (InstanceError, OSError, UpdateError) as exc:
            message = (
                "An older CrystalSketch instance is still running. Stop it in its original "
                "terminal once, then run Crystal again."
                if str(exc) == "legacy-instance-running" else
                "CrystalSketch is starting or updating, or its instance state is unavailable. "
                "Use the existing window or wait and run Crystal again."
            )
            Console(stderr=True).print(message)
            raise typer.Exit(code=1) from exc
        if isinstance(instance, InstanceInfo):
            Console().print(Text(f"CrystalSketch v{instance.version} is already running."))
            Console().print(_startup_server_line(instance.url))
            probe_host = instance.probe_host
            if not no_open and probe_host is not None:
                _open_browser_when_ready(instance.url, probe_host, instance.port)
            return
        lease = instance

    try:
        _run_new_gui(
            host=host, port=port, no_open=no_open, reload=reload, verbose=verbose,
            fallback_to_available_port=fallback_to_available_port, lease=lease,
        )
    finally:
        if lease is not None:
            lease.close()


def _run_new_gui(
    host: str,
    port: int,
    no_open: bool,
    reload: bool,
    verbose: bool,
    fallback_to_available_port: bool,
    lease: InstanceLease | None = None,
) -> None:
    selected_port = _choose_port(
        host,
        port,
        fallback_to_available_port=fallback_to_available_port,
    )
    url = _display_url(host, selected_port)
    info = lease.publish(host=host, port=selected_port,
                         version=_current_version()) if lease is not None else None

    _print_startup_banner(url)
    if not no_open:
        _start_browser_opener(url, host, selected_port)

    log_options = _uvicorn_log_options(verbose)
    if reload:
        _run_uvicorn(
            "crystalsketch.server.app:create_app",
            host=host,
            port=selected_port,
            factory=True,
            reload=True,
            **log_options,
        )
        return

    from crystalsketch.server.app import create_app

    application = create_app(instance_info=info) if info is not None else create_app()
    _run_uvicorn(application, host=host, port=selected_port, **log_options)


@app.command(context_settings={"help_option_names": HELP_OPTION_NAMES}, hidden=True)
def gui(
    ctx: typer.Context,
    host: HostOption = DEFAULT_HOST,
    port: PortOption = DEFAULT_PORT,
    no_open: NoOpenOption = False,
    reload: ReloadOption = False,
    verbose: VerboseOption = False,
) -> None:
    """Start the local CrystalSketch GUI server.

    Kept as a compatibility alias for `Crystal`.
    """
    _run_gui(
        host=host,
        port=port,
        no_open=no_open,
        reload=reload,
        verbose=verbose,
        fallback_to_available_port=_parameter_uses_default(ctx, "port"),
    )
