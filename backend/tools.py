"""Curated table of well-known non-package dependencies (languages, runtimes,
package managers, build tools, system libs).  Values (size, first release,
releases/year) are approximations of a typical install / project history."""
from __future__ import annotations

from .models import Dep, parse_iso, empty_metrics

MB = 1_000_000

# key: (display name, kind, github "owner/repo", first release date, approx install bytes, releases per year, description)
_T = {
    # languages
    "javascript": ("JavaScript", "language", "tc39/ecma262", "1995-12-04", 4 * MB, None, "The ECMAScript language specification"),
    "typescript": ("TypeScript", "language", "microsoft/TypeScript", "2012-10-01", 23 * MB, 14, "Typed superset of JavaScript"),
    "python": ("Python", "language", "python/peps", "1991-02-20", 45 * MB, None, "The Python language and standard library"),
    "rust": ("Rust", "language", "rust-lang/reference", "2010-07-07", 60 * MB, None, "The Rust language and standard library"),
    "go": ("Go", "language", "golang/go", "2009-11-10", 250 * MB, 4, "The Go language and standard library"),
    "ruby": ("Ruby", "language", "ruby/ruby", "1995-12-21", 60 * MB, 12, "The Ruby language and standard library"),
    "java": ("Java", "language", "openjdk/jdk", "1996-01-23", 300 * MB, 8, "The Java language and class library"),
    "php": ("PHP", "language", "php/php-src", "1995-06-08", 30 * MB, 25, "The PHP language"),
    # runtimes / compilers
    "node": ("Node.js", "runtime", "nodejs/node", "2009-05-27", 110 * MB, 45, "JavaScript runtime built on V8"),
    "v8": ("V8", "runtime", "v8/v8", "2008-09-02", 35 * MB, 12, "Google's JavaScript and WebAssembly engine"),
    "cpython": ("CPython", "runtime", "python/cpython", "1991-02-20", 100 * MB, 20, "Reference Python interpreter"),
    "rustc": ("rustc", "runtime", "rust-lang/rust", "2012-01-20", 700 * MB, 9, "The Rust compiler and standard library"),
    "llvm": ("LLVM", "build_tool", "llvm/llvm-project", "2003-10-24", 450 * MB, 8, "Compiler backend used by rustc"),
    "jvm": ("JVM (OpenJDK)", "runtime", "openjdk/jdk", "1996-01-23", 300 * MB, 8, "Java virtual machine"),
    "cruby": ("CRuby", "runtime", "ruby/ruby", "1995-12-21", 60 * MB, 12, "Reference Ruby interpreter"),
    "php-runtime": ("PHP Zend Engine", "runtime", "php/php-src", "1999-05-22", 30 * MB, 25, "PHP interpreter"),
    "gcc": ("GCC/Clang toolchain", "build_tool", "gcc-mirror/gcc", "1987-03-22", 150 * MB, 6, "C/C++ compiler toolchain"),
    # package managers
    "npm": ("npm", "package_manager", "npm/cli", "2010-01-12", 11 * MB, 100, "Node package manager"),
    "yarn": ("Yarn", "package_manager", "yarnpkg/berry", "2016-10-11", 5 * MB, 20, "Node package manager"),
    "pnpm": ("pnpm", "package_manager", "pnpm/pnpm", "2016-06-26", 20 * MB, 60, "Fast, disk-efficient Node package manager"),
    "bun": ("Bun", "package_manager", "oven-sh/bun", "2021-07-05", 95 * MB, 40, "JavaScript runtime and package manager"),
    "pip": ("pip", "package_manager", "pypa/pip", "2008-10-26", 11 * MB, 5, "Python package installer"),
    "poetry": ("Poetry", "package_manager", "python-poetry/poetry", "2018-02-28", 60 * MB, 15, "Python dependency manager"),
    "uv": ("uv", "package_manager", "astral-sh/uv", "2024-02-15", 40 * MB, 60, "Fast Python package manager"),
    "pipenv": ("Pipenv", "package_manager", "pypa/pipenv", "2017-01-24", 25 * MB, 12, "Python dependency manager"),
    "cargo": ("Cargo", "package_manager", "rust-lang/cargo", "2014-06-24", 25 * MB, 9, "Rust package manager and build tool"),
    "gomod": ("Go modules", "package_manager", "golang/go", "2018-08-24", None, 4, "Go dependency management"),
    "bundler": ("Bundler", "package_manager", "rubygems/rubygems", "2010-04-16", 5 * MB, 12, "Ruby dependency manager"),
    "composer": ("Composer", "package_manager", "composer/composer", "2012-03-01", 3 * MB, 10, "PHP dependency manager"),
    "maven": ("Apache Maven", "build_tool", "apache/maven", "2004-07-13", 10 * MB, 6, "Java build and dependency tool"),
    "gradle": ("Gradle", "build_tool", "gradle/gradle", "2008-04-28", 130 * MB, 20, "JVM build tool"),
    # build tools / system
    "make": ("GNU Make", "build_tool", "mirror/make", "1988-01-01", 3 * MB, 1, "Build automation tool"),
    "cmake": ("CMake", "build_tool", "Kitware/CMake", "2000-02-01", 100 * MB, 8, "Cross-platform build system generator"),
    "docker": ("Docker", "build_tool", "moby/moby", "2013-03-20", 450 * MB, 12, "Container build and runtime engine"),
    "git": ("git", "system", "git/git", "2005-04-07", 50 * MB, 15, "Distributed version control system"),
    "linux": ("Linux kernel", "system", "torvalds/linux", "1991-09-17", 120 * MB, 70, "Operating system kernel"),
    "glibc": ("glibc", "system", "bminor/glibc", "1992-01-01", 25 * MB, 2, "GNU C standard library"),
    "musl": ("musl libc", "system", "bminor/musl", "2011-02-07", 2 * MB, 2, "Lightweight C standard library"),
}

# well-known Docker Hub official images -> GitHub repo
DOCKER_REPOS = {
    "node": "nodejs/node", "python": "python/cpython", "golang": "golang/go",
    "rust": "rust-lang/rust", "nginx": "nginx/nginx", "redis": "redis/redis",
    "postgres": "postgres/postgres", "ruby": "ruby/ruby", "php": "php/php-src",
    "openjdk": "openjdk/jdk", "mysql": "mysql/mysql-server",
}


def make_tool(key: str, *, version=None, source_file=None, direct=True, uses=None) -> Dep:
    name, kind, repo, first, size, rel, desc = _T[key]
    d = Dep(ecosystem="system", name=name, kind=kind, version=version, direct=direct,
            source_file=source_file, repo_url=f"https://github.com/{repo}" if repo else None,
            description=desc, metrics=empty_metrics())
    d.extra["tool_key"] = key
    m = d.metrics
    m["size_bytes"] = size
    m["first_release"] = first + "T00:00:00Z"
    if rel is not None:
        m["recent_commits"] = rel
        m["recent_commits_source"] = "releases"
    m["import_count"] = uses
    return d
