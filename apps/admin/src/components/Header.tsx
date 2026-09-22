import { Button } from "antd";
import pkg from "../../../../package.json";
import { ReadOutlined } from "@ant-design/icons";

export function Header() {
    return <div className="relative">
        <div className="absolute top-0 left-0 z-10 mt-5 p-12 text-white">
            <div className="font-bold text-4xl">
                ArSrNa OpenVOD
            </div>
            <div className="mt-5 text-lg">版本：{pkg.version}｜Powered by Ar-Sr-Na｜Apache 2.0 License.</div>
            <div className="mt-5 flex flex-wrap gap-2">
                <Button icon={<ReadOutlined />} type="primary" href="https://arsrna-it.feishu.cn/drive/folder/TY3lf4NNIlhgXKd6t2acnItMnAg?from=from_copylink" target="_blank">查看文档</Button>
            </div>
        </div>
        <div className="w-full h-75">
            <div className="bg-linear-to-r from-black/70 to-black/0 w-full h-full absolute top-0 left-0 z-0 rounded-md" />
            <img src="/s_DSC_0106.avif" className="w-full h-full object-cover z-0 rounded-md" />
        </div>
    </div>
}