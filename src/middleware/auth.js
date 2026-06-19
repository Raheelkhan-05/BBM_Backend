import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = header.split(" ")[1];

  try {
    console.log("Token:", token);
    console.log("Length:", token.length);
    // 1. Let Supabase verify its own token — no JWT_SECRET needed
    const { data: { user: authUser }, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    console.log(authError);
    console.log(authUser);

    if (authError || !authUser) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // console.log("Authenticated user:", authUser);

    // 2. Fetch your app's user row (has your role, name, etc.)
    const { data: userData, error: userError } = await supabaseAdmin
      .from("users")
      .select("id, email, role")
      .eq("id", authUser.id)
      .single();

      // console.log("User data:", userData);

    if (userError || !userData) {
      return res.status(401).json({ message: "User profile not found" });
    }

    if (!userData.role || userData.role === "UNASSIGNED") {
      return res.status(403).json({ message: "Account not approved" });
    }

    // 3. req.user now has id, email, role, name — exactly what controllers expect
    req.user = userData;
    
    // console.log("req.user set:", req.user);
    next();
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

export default authenticate;