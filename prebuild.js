var path = require('path');
var semver = require('semver');
var url = require('url');
var qiniu = require('qiniu');
var pkg = require('./package.json');
var config = require('rc')('qiniu');
var http = require('http');
var fs = require('fs');
var exec = require('child_process').exec;

var whiteModules = ['11', '14', '42', '44', '46', '47', '48'];  //支持的 node_abi 列表
var binaries = ["lwip_decoder", "lwip_encoder", "lwip_image"];
var opts = [];
for (var i = 0; i < binaries.length; i++) {
    //得到目录路径
    opts.push(evaluate(pkg, binaries[i]));
}

if (process.env.TMTBUILD) {
    publishNodeFile();
} else {
    downloadNodeFile();
}

function publishNodeFile() {

    rebuild('node-gyp rebuild', function () {
        //准备上传
        qiniu.conf.ACCESS_KEY = config['ACCESS_KEY'];
        qiniu.conf.SECRET_KEY = config['SECRET_KEY'];

        var uptoken = new qiniu.rs.PutPolicy('node-lwip').token();

        for (var i = 0; i < opts.length; i++) {
            uploadFile(opts[i].module, opts[i].hosted_tarball.replace(opts[i].host, ''), uptoken);
        }
    });
}

function downloadNodeFile() {
    //创建目录
    mkdirs(path.join(__dirname, "build", "Release"), 0755, function (e) {
        //下载
        downFile(opts[0].module, opts[0].hosted_tarball, function (err) {
            if (err) {
                rebuild('node-gyp rebuild');
            } else {
                downFile(opts[1].module, opts[1].hosted_tarball, function (err) {
                    if (err) {
                        rebuild('node-gyp rebuild');
                    } else {
                        downFile(opts[2].module, opts[2].hosted_tarball, function (err) {
                            if (err) {
                                rebuild('node-gyp rebuild');
                            }
                        });
                    }
                });
            }
        });
    });
}

function uploadFile(localFile, key, uptoken) {
    var extra = new qiniu.io.PutExtra();
    qiniu.io.putFile(uptoken, key, localFile, extra, function (err, ret) {
        if (!err) {
            console.log('published to ', key)
        } else {
            console.log(err);
        }
    });
}

function friendTips(){

    if(process.platform.indexOf('win32') === -1){
        return;
    }

    var mes = {
        node: process.versions.node,
        modules: process.versions.modules
    };

    console.log(mes);

    if(whiteModules.indexOf(mes.modules) === -1){
        console.log('Your node version is out of date, please install the latest one!');
    }
}

function downFile(localFilePath, remoteFilePath, callback) {
    var file = fs.createWriteStream(localFilePath);
    remoteFilePath = 'http://' + remoteFilePath;

    http.get(remoteFilePath, function (response) {
        if (response.statusCode !== 200) {

            friendTips();

            callback.apply(this, [true]);
        } else {
            response.pipe(file);
            file.on('finish', function () {
                console.log('Download success: ', localFilePath);
                callback.apply(this, [false]);
            });
        }

    }).on('error', function (err) {
        console.log('Download fail: ', localFilePath, err);

        friendTips();

        //下载失败则执行 node-gyp rebuild
        callback.apply(this, [true]);
    });
}

function rebuild(command, callback) {
    var ls = exec(command, function (err, stdout, stderr) {
        if (err) throw err;
        callback && callback();
    });

    ls.stdout.on('data', function (data) {
        console.log(data);
    });

    ls.stderr.on('data', function (data) {
        console.log(data);
    });

    ls.on('exit', function (code) {
        console.log('child process exited with code ' + code);
    });
}

function get_node_abi(runtime, versions) {
    if (!runtime) {
        throw new Error("get_node_abi requires valid runtime arg");
    }
    if (!versions) {
        throw new Error("get_node_abi requires valid process.versions object");
    }
    var sem_ver = semver.parse(versions.node);
    if (sem_ver.major === 0 && sem_ver.minor % 2) { // odd series
        // https://github.com/mapbox/node-pre-gyp/issues/124
        return runtime + '-v' + versions.node;
    } else {
        return versions.modules ? runtime + '-v' + (+versions.modules) :
        'v8-' + versions.v8.split('.').slice(0, 2).join('.');
    }
}

function eval_template(template, opts) {
    Object.keys(opts).forEach(function (key) {
        var pattern = '{' + key + '}';
        while (template.indexOf(pattern) > -1) {
            template = template.replace(pattern, opts[key]);
        }
    });
    return template;
}

// url.resolve needs single trailing slash
// to behave correctly, otherwise a double slash
// may end up in the url which breaks requests
// and a lacking slash may not lead to proper joining
function fix_slashes(pathname) {
    if (pathname.slice(-1) != '/') {
        return pathname + '/';
    }
    return pathname;
}

// remove double slashes
// note: path.normalize will not work because
// it will convert forward to back slashes
function drop_double_slashes(pathname) {
    return pathname.replace(/\/\//g, '/');
}

var default_package_name = '{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz';
var default_remote_path = '';

function evaluate(package_json, module_name) {
    var v = package_json.version;
    var module_version = semver.parse(v);
    var runtime = 'node';
    var opts = {
        name: package_json.name,
        configuration: 'Release',
        module_name: module_name,
        version: module_version.version,
        prerelease: module_version.prerelease.length ? module_version.prerelease.join('.') : '',
        build: module_version.build.length ? module_version.build.join('.') : '',
        major: module_version.major,
        minor: module_version.minor,
        patch: module_version.patch,
        runtime: runtime,
        node_abi: get_node_abi(runtime, process.versions),
        platform: process.platform,
        target_platform: process.platform,
        arch: process.arch,
        target_arch: process.arch,
        module_main: package_json.main
    };
    opts.host = fix_slashes(eval_template(package_json.binary.host, opts));
    opts.module_path = eval_template(package_json.binary.module_path, opts);

    // resolve relative to current working directory: works for node-pre-gyp commands
    opts.module_path = path.resolve(opts.module_path);
    opts.module = path.join(opts.module_path, opts.module_name + '.node');
    opts.remote_path = package_json.binary.remote_path ? drop_double_slashes(fix_slashes(eval_template(package_json.binary.remote_path, opts))) : default_remote_path;
    var package_name = package_json.binary.package_name ? package_json.binary.package_name : default_package_name;
    opts.package_name = eval_template(package_name, opts);
    opts.staged_tarball = path.join('build/stage', opts.remote_path, opts.package_name);
    opts.hosted_path = url.resolve(opts.host, opts.remote_path);
    opts.hosted_tarball = url.resolve(opts.hosted_path, opts.package_name);
    return opts;
}

function mkdirs(dirpath, mode, callback) {
    fs.exists(dirpath, function (exists) {
        if (exists) {
            callback(dirpath);
        } else {
            mkdirs(path.dirname(dirpath), mode, function () {
                fs.mkdir(dirpath, mode, callback);
            });
        }
    });
}

