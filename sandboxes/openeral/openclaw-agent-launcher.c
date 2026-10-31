#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const char NODE_BIN[] = "/usr/bin/node";
static const char OPENCLAW_ENTRYPOINT[] = "/usr/lib/node_modules/openclaw/openclaw.mjs";
static volatile sig_atomic_t child_pid = -1;

static void forward_signal(int signal_number) {
    int saved_errno = errno;
    pid_t pid = (pid_t)child_pid;

    if (pid > 0) {
        (void)kill(pid, signal_number);
    }
    errno = saved_errno;
}

static int install_handler(int signal_number, void (*handler)(int)) {
    struct sigaction action = {0};

    action.sa_handler = handler;
    if (sigemptyset(&action.sa_mask) == -1) {
        return -1;
    }
    return sigaction(signal_number, &action, NULL);
}

static int configure_forwarding_handlers(void) {
    if (install_handler(SIGINT, forward_signal) == -1 ||
        install_handler(SIGTERM, forward_signal) == -1 ||
        install_handler(SIGHUP, forward_signal) == -1) {
        return -1;
    }
    return 0;
}

static int restore_default_handlers(void) {
    if (install_handler(SIGINT, SIG_DFL) == -1 ||
        install_handler(SIGTERM, SIG_DFL) == -1 ||
        install_handler(SIGHUP, SIG_DFL) == -1) {
        return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    sigset_t forwarded_signals;
    sigset_t original_mask;
    char *openclaw_argv[6] = {
        (char *)NODE_BIN,
        (char *)OPENCLAW_ENTRYPOINT,
        (char *)"tui",
        (char *)"--local",
        NULL,
        NULL,
    };
    char *session_option = NULL;
    pid_t pid;
    int status;

    if (argc > 2) {
        fprintf(stderr, "openrind-openclaw-agent: expected at most one session key\n");
        return 2;
    }
    if (argc == 2) {
        static const char prefix[] = "--session=";
        size_t key_length = strlen(argv[1]);

        if (key_length > SIZE_MAX - sizeof(prefix)) {
            fprintf(stderr, "openrind-openclaw-agent: session key is too long\n");
            return 2;
        }
        session_option = malloc(sizeof(prefix) + key_length);
        if (session_option == NULL) {
            perror("openrind-openclaw-agent: allocate session option");
            return 1;
        }
        memcpy(session_option, prefix, sizeof(prefix) - 1);
        memcpy(session_option + sizeof(prefix) - 1, argv[1], key_length + 1);
        openclaw_argv[4] = session_option;
    }

    if (setenv("HOME", "/sandbox/openclaw-home", 1) == -1) {
        perror("openrind-openclaw-agent: set HOME");
        return 1;
    }

    if (unsetenv("NODE_OPTIONS") == -1 || unsetenv("NODE_PATH") == -1) {
        perror("openrind-openclaw-agent: sanitize Node environment");
        return 1;
    }

    if (sigemptyset(&forwarded_signals) == -1 ||
        sigaddset(&forwarded_signals, SIGINT) == -1 ||
        sigaddset(&forwarded_signals, SIGTERM) == -1 ||
        sigaddset(&forwarded_signals, SIGHUP) == -1 ||
        sigprocmask(SIG_BLOCK, &forwarded_signals, &original_mask) == -1) {
        perror("openrind-openclaw-agent: block signals");
        return 1;
    }

    if (configure_forwarding_handlers() == -1) {
        perror("openrind-openclaw-agent: install signal handlers");
        return 1;
    }

    pid = fork();
    if (pid == -1) {
        perror("openrind-openclaw-agent: fork");
        free(session_option);
        return 1;
    }

    if (pid == 0) {
        if (restore_default_handlers() == -1 ||
            sigprocmask(SIG_SETMASK, &original_mask, NULL) == -1) {
            perror("openrind-openclaw-agent: restore child signals");
            _exit(126);
        }
        execv(NODE_BIN, openclaw_argv);
        int exec_errno = errno;
        perror("openrind-openclaw-agent: exec /usr/bin/node");
        _exit(exec_errno == ENOENT ? 127 : 126);
    }

    child_pid = pid;
    free(session_option);
    if (sigprocmask(SIG_SETMASK, &original_mask, NULL) == -1) {
        perror("openrind-openclaw-agent: restore parent signals");
        (void)kill(pid, SIGTERM);
        return 1;
    }

    while (waitpid(pid, &status, 0) == -1) {
        if (errno != EINTR) {
            perror("openrind-openclaw-agent: waitpid");
            return 1;
        }
    }
    child_pid = -1;

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 1;
}
