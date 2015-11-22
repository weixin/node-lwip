//提前拉文件回来
var binaries = ["lwip_decoder", "lwip_encoder", "lwip_image"];

for(var i = 0; i < binaries.length; i++) {
    var opt = evaluate(pkg, binaries[i]);
}

//先判断是否存在


//不存在的放在，就用 node-gyp build 编译