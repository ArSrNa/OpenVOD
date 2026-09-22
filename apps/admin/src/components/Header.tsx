import pkg from "../../../../package.json";

export function Header() {
    return <div className="relative">
        <div className="absolute top-0 left-0 z-10 mt-10 p-12 text-white">
            <div className="font-bold text-4xl">
                ArSrNa OpenVOD
            </div>
            <div className="mt-5 text-xl">版本：{pkg.version}. Powered by Ar-Sr-Na. Apache 2.0 License.</div>
        </div>
        <div className="w-full h-75">
            <div className="bg-linear-to-r from-black/70 to-black/0 w-full h-full absolute top-0 left-0 z-0 rounded-md" />
            <img src="/s_DSC_0106.avif" className="w-full h-full object-cover z-0 rounded-md" />
        </div>
    </div>
}